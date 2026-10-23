# cue-review: deterministic multi-agent code review driving cue-agent.
#
# Spec: palekiwi/palekiwi/cue-review-script/spec/index.md
# Interfaces: palekiwi/palekiwi/cue-review-script/note/concrete-interfaces.md
#
# Targets: pr <N|branch>, branch [<name>], commit <sha>, range <base>..<head>.
# Each target normalizes to resolved (base_sha, head_sha), a context name and
# a window name, then hands off to one engine. Detached (review tmux session)
# is the default; --foreground blocks. The engine always diffs tree-to-tree
# between the two resolved SHAs; merge-base semantics live in the targets
# (pr, branch, and the compat `run` alias), never in the engine.
#
# Exit codes: 0 all artifacts produced (or empty diff), 1 missing artifacts
# or a phase produced none, 2 validation error before any agent ran,
# 130 interrupted (mapped by the packaged bash wrapper, since nu aborts on
# SIGINT before it can report). Progress on stderr, summary on stdout.

const PHASES = [reviewers merge verifiers]
const ENTRY_FIELDS = [name agent prompt model thinking system_prompt]
const MAX_ENTRIES = 4
const DEFAULT_MANIFEST = "default"

# Manifests are global only: <config>/cue/review/<name>.json, prompts
# referenced relative to it. Project-specific manifests are name-prefixed
# (e.g. spabreaks-default). A value containing "/" or ending in ".json"
# is taken as a path instead of a name.
def manifest-dir [] {
  let xdg = ($env.XDG_CONFIG_HOME? | default "")
  let base = if $xdg == "" { $env.HOME | path join ".config" } else { $xdg }
  $base | path join cue review
}

def resolve-manifest [value: string] {
  if ($value | str contains "/") or ($value | str ends-with ".json") {
    return ($value | path expand)
  }
  if ($value !~ '^[a-z0-9][a-z0-9-]*$') { die $"manifest name must match [a-z0-9-]+: ($value)" }
  let p = (manifest-dir | path join $"($value).json")
  if not ($p | path exists) {
    let known = (try { ls (manifest-dir) | where name =~ '\.json$' | get name | path parse | get stem | str join ", " } catch { "" })
    die $"no manifest named '($value)' in (manifest-dir) \(known: ($known)\)"
  }
  $p
}

def log [msg: string] { print -e $"cue-review: ($msg)" }

def die [msg: string, code: int = 2] {
  log $"error: ($msg)"
  exit $code
}

def main [] {
  print -e "usage: cue-review pr <number-or-branch>... [--context <slug>] [--foreground] [-C <dir>]"
  print -e "       cue-review branch [<name>]... [--base <integration-ref>] [--context <slug>] [--foreground] [-C <dir>]"
  print -e "       cue-review commit <sha>... [--context <slug>] [--foreground] [-C <dir>]"
  print -e "       cue-review range <base>..<head>... [--context <slug>] [--foreground] [-C <dir>]"
  print -e "       cue-review status"
  print -e "detached (review tmux session) is the default; --foreground blocks"
  exit 2
}

# Resolve a string-or-{file} value relative to the manifest directory.
def resolve-text [value: any, dir: path, what: string] {
  match ($value | describe | str replace -r '<.*' '') {
    "string" => $value
    "record" => {
      if ($value | columns) != [file] { die $"($what): expected a string or { \"file\": ... }" }
      let p = ($dir | path join $value.file)
      if not ($p | path exists) { die $"($what): file not found: ($p)" }
      open --raw $p
    }
    _ => { die $"($what): expected a string or { \"file\": ... }" }
  }
}

# Validate the manifest and return { reviewers: [...], merge: [...], verifiers: [...] }
# with prompts resolved to strings.
def load-manifest [file: path] {
  if not ($file | path exists) { die $"manifest not found: ($file)" }
  let raw = try { open --raw $file | from json } catch { die $"manifest is not valid JSON: ($file)" }
  if ($raw | describe | str starts-with "record") == false { die "manifest: root must be an object" }
  let unknown = ($raw | columns | where {|k| $k not-in $PHASES })
  if ($unknown | is-not-empty) { die $"manifest: unknown keys: ($unknown | str join ', ')" }
  let dir = ($file | path dirname)

  $PHASES | each {|phase|
    let entries = ($raw | get -o $phase | default [])
    if ($entries | describe | str starts-with "list") == false and ($entries | describe | str starts-with "table") == false {
      die $"manifest: ($phase) must be a list"
    }
    let n = ($entries | length)
    if $phase == "reviewers" and $n == 0 { die $"manifest: ($phase) needs at least one entry" }
    if $n > $MAX_ENTRIES { die $"manifest: ($phase) has ($n) entries, max ($MAX_ENTRIES)" }

    let resolved = ($entries | enumerate | each {|it|
      let e = $it.item
      let at = $"($phase)[($it.index)]"
      if ($e | describe | str starts-with "record") == false { die $"manifest: ($at) must be an object" }
      let bad = ($e | columns | where {|k| $k not-in $ENTRY_FIELDS })
      if ($bad | is-not-empty) { die $"manifest: ($at): unknown keys: ($bad | str join ', ')" }
      for k in [name agent prompt] {
        if ($e | get -o $k) == null { die $"manifest: ($at): missing ($k)" }
      }
      if ($e.name !~ '^[a-z0-9-]+$') { die $"manifest: ($at): name must match [a-z0-9-]+" }
      {
        name: $e.name
        agent: $e.agent
        prompt: (resolve-text $e.prompt $dir $"($at).prompt")
        model: ($e | get -o model)
        thinking: ($e | get -o thinking)
        system_prompt: (if ($e | get -o system_prompt) == null { null } else {
          resolve-text $e.system_prompt $dir $"($at).system_prompt"
        })
      }
    })
    let names = ($resolved | get -o name | default [])
    if ($names | uniq | length) != ($names | length) { die $"manifest: ($phase): duplicate names" }
    { phase: $phase, entries: $resolved }
  } | reduce -f {} {|it, acc| $acc | insert $it.phase $it.entries }
}

def repo-of [dir: path] {
  let top = (do { ^git -C $dir rev-parse --show-toplevel } | complete)
  if $top.exit_code != 0 { die $"not a git repository: ($dir)" }
  $top.stdout | str trim
}

def rev-parse [dir: path, ref: string] {
  let r = (do { ^git -C $dir rev-parse --verify --quiet $"($ref)^{commit}" } | complete)
  if $r.exit_code != 0 { die $"cannot resolve ref: ($ref)" }
  $r.stdout | str trim
}

def merge-base-of [repo: path, a: string, b: string] {
  let r = (do { ^git -C $repo merge-base $a $b } | complete)
  if $r.exit_code != 0 {
    die $"no merge-base between ($a) and ($b); are they from unrelated histories?"
  }
  $r.stdout | str trim
}

# The default branch of origin, or the --base override. Never guesses:
# without origin/HEAD and without --base, fail with a hint.
def integration-ref [repo: path, base: any] {
  if $base != null { return $base }
  let r = (do { ^git -C $repo symbolic-ref --quiet refs/remotes/origin/HEAD } | complete)
  if $r.exit_code != 0 {
    die "cannot determine the default branch (origin/HEAD is unset); pass --base <integration-ref>"
  }
  $r.stdout | str trim | str replace -r '^refs/remotes/' ''
}

def slugify [name: string] {
  $name | str lowercase
  | str replace -a '/' '-'
  | str replace -a -r '[^a-z0-9._-]' '-'
  | str trim -c '-'
}

# Create the review context if missing, then pin it (idempotent marker).
def ensure-context [repo: path, slug: string, title: string, parent: any] {
  if ((do { ^cue status -C $repo --context $slug } | complete).exit_code != 0) {
    let args = if $parent == null { [] } else { [--parent $parent] }
    let created = (do { ^cue context create $slug --title $title --mode review -C $repo ...$args } | complete)
    if $created.exit_code != 0 { die $created.stderr }
    log $"created context ($slug)"
  }
  let pin = (do { ^cue context pin $slug -C $repo } | complete)
  if $pin.exit_code != 0 { log $"warning: pin failed: ($pin.stderr | str trim)" }
}

# Set @<key> window options on a tmux window: the given target, else the
# window running this process (no-op outside tmux). Links a window to its
# review for the picker and `status`.
def tag-window [opts: record, --target: string] {
  let target = ($target | default ($env.TMUX_PANE? | default ""))
  if ($target | is-empty) { return }
  for kv in ($opts | transpose k v) {
    do { ^tmux set -q -w -t $target $"@($kv.k)" $kv.v } | complete | ignore
  }
}

# Is a review window for this context still running?
def running-for [context: string] {
  if ((do { ^tmux has-session -t review } | complete).exit_code != 0) { return false }
  let rows = (^tmux list-windows -t review -F "#{@review_context}\t#{@review_state}" | split row "\n")
  $rows | any {|l|
    let p = ($l | split column "\t" c s | first)
    $p.c == $context and $p.s == "running"
  }
}

def input-block [ctx: record, phase: string, name: string, inputs: list<string>] {
  let input_lines = if ($inputs | is-empty) { ["inputs: []"] } else {
    ["inputs:"] ++ ($inputs | each {|p| $"  - ($p)" })
  }
  [
    "<review-run>"
    $"phase: ($phase)"
    $"name: ($name)"
    $"context: ($ctx.slug)"
    $"run_id: ($ctx.run_id)"
    $"base: ($ctx.base)"
    $"head: ($ctx.head)"
    $"diff: ($ctx.diff)"
    $"run_record: ([$ctx.store $ctx.address review $ctx.run_id run.json] | path join)"
    ...$input_lines
    "output:"
    "  tool: cue-review"
    $"  context: ($ctx.slug)"
    $"  filename: ($ctx.run_id)/($phase)-($name).json"
    "</review-run>"
  ] | str join "\n"
}

def artifact-path [ctx: record, phase: string, name: string] {
  [$ctx.store $ctx.address review $ctx.run_id $"($phase)-($name).json"] | path join
}

# Keep receipt metrics, not response text or container-local logs. `model`
# is configuration-first in cue-agent; it is not an observed-model guarantee.
def entry-receipt [run: any] {
  if $run == null { return null }
  $run | select -o run_id batch_id agent model outcome exit_code signal duration_ms turns tokens_input tokens_output cost_usd error events_malformed events_oversized events_truncated persistence_errors cleanup_errors
}

# Observe requests, not successful reads or comprehension. Never retain raw
# arguments, command strings, search patterns or response text in the summary.
def observed-activity [run: any] {
  let run_path = ($run | get -o run_path)
  if $run_path == null { return { status: "unavailable", models: [], requests: [] } }
  let path = ($run_path | path join events.jsonl)
  let lines = try { open --raw $path | lines | first 10001 } catch {
    return { status: "unavailable", models: [], requests: [] }
  }
  mut models = []
  mut requests = []
  mut requests_limited = false
  mut malformed = 0
  for line in ($lines | first 10000) {
    let event = try { $line | from json } catch { null }
    if not ($event | describe | str starts-with "record") {
      $malformed = $malformed + 1
      continue
    }
    if $event.type? == "message_end" and (try { $event.message.role? } catch { null }) == "assistant" {
      let model = $event.message.model?
      if $model != null {
        $models = ($models | append { provider: $event.message.provider?, model: $model } | uniq)
      }
    }
    if $event.type? == "tool_execution_start" {
      let tool = $event.toolName?
      if $tool in [read grep find ls] {
        let path = try { $event.args.path? } catch { null }
        if ($path | describe) == "string" {
          let request = { tool: $tool, path: $path }
          if $request not-in $requests {
            if ($requests | length) < 500 {
              $requests = ($requests | append $request)
            } else { $requests_limited = true }
          }
        }
      }
    }
  }
  {
    status: "available"
    models: $models
    requests: $requests
    malformed_lines: $malformed
    events_limited: (($lines | length) > 10000)
    requests_limited: $requests_limited
    stream_truncated: ($run | get -o events_truncated)
  }
}

# Only this runner-owned summary is mutable. Agent artifacts remain write-once.
# Rename from the same directory so readers never observe partially written JSON.
def save-run-record [path: path, record: record] {
  let tmp = (^mktemp $"($path).XXXXXX" | str trim)
  try {
    $record | to json | save -f $tmp
    mv -f $tmp $path
  } catch {|err|
    rm -f $tmp
    error make { msg: $"cannot persist run summary: ($err.msg)" }
  }
}

# Run one phase through cue-agent, returning artifacts and durable entry data.
def run-phase [ctx: record, phase: string, entries: list, inputs: list<string>] {
  let tasks = ($entries | each {|e|
    let prompt = $"($e.prompt | str trim --right)\n\n(input-block $ctx $phase $e.name $inputs)\n"
    mut t = {
      agent: $e.agent
      prompt: $prompt
      label: $"($phase)-($e.name)"
    }
    for k in [model thinking system_prompt] {
      let v = ($e | get $k)
      if $v != null { $t = ($t | insert $k $v) }
    }
    $t
  })
  let spec = {
    label: $"review-($ctx.run_id)-($phase)"
    defaults: {
      cwd: $ctx.repo
      worktree: { base: $ctx.head, ephemeral: true }
      context: $ctx.address
      env: { CUE_CONTEXT: $ctx.slug }
    }
    tasks: $tasks
  }
  let spec_file = (mktemp -t cue-review-spec.XXXXXX.json)
  let receipt_file = (mktemp -t cue-review-receipt.XXXXXX.json)
  $spec | to json | save -f $spec_file

  log $"phase ($phase): starting ($entries | length) agent\(s\): ($entries | get name | str join ', ')"
  let start = (date now)
  # stdout (receipt) to a file; cue-agent stderr passes through.
  let code = try {
    ^cue-agent run --json --spec $spec_file o> $receipt_file
    0
  } catch {|err| $env.LAST_EXIT_CODE? | default 1 }
  rm -f $spec_file

  let parsed = try { open --raw $receipt_file | from json } catch { null }
  let receipt = if ($parsed | describe | str starts-with "record") {
    let runs = ($parsed | get -o runs)
    if ($runs | describe | str starts-with "list") or ($runs | describe | str starts-with "table") {
      $parsed
    } else { null }
  } else { null }
  rm -f $receipt_file
  if $receipt == null {
    log $"phase ($phase): no readable cue-agent receipt \(exit ($code)\)"
    # Missing receipts are not evidence of interruption. Still preserve any
    # artifacts produced before the supervisor failed.
  }

  let runs = ($receipt | get -o runs | default [])
  let results = ($entries | enumerate | each {|it|
    let candidate = ($runs | get -o $it.index)
    let run = if ($candidate | describe | str starts-with "record") { $candidate } else { null }
    let path = (artifact-path $ctx $phase $it.item.name)
    let ok = ($path | path exists)
    let outcome = ($run | get -o outcome | default "unknown")
    let secs = (($run | get -o duration_ms | default 0) / 1000 | math round)
    let cost = ($run | get -o cost_usd | default 0 | math round -p 3)
    let status = if $ok { "ok" } else { "MISSING artifact" }
    mut line = $"  ($phase)-($it.item.name): ($outcome), ($secs)s, $($cost), ($status)"
    let err = ($run | get -o error)
    if (not $ok) and $err != null { $line = $"($line) -- ($err)" }
    log $line
    for c in ($run | get -o cleanup_errors | default []) { log $"  cleanup: ($c)" }
    {
      ok: $ok, path: $path, outcome: $outcome
      entry: {
        name: $it.item.name
        agent: $it.item.agent
        requested_model: $it.item.model
        inputs: $inputs
        artifact: $path
        artifact_present: $ok
        receipt_status: (if $run == null { "missing" } else { "available" })
        receipt: (entry-receipt $run)
        observed: (observed-activity $run)
      }
    }
  })
  let produced = ($results | where ok | get path)
  let interrupted = ($results | any {|r| $r.outcome == "aborted" })
  let elapsed = ((date now) - $start | format duration sec | str replace -r '\.\d+' '')
  log $"phase ($phase): ($produced | length)/($entries | length) artifacts in ($elapsed)"
  {
    produced: $produced
    missing: (($entries | length) - ($produced | length))
    interrupted: ($interrupted or $code == 130)
    receipt_missing: ($results | any {|r| $r.entry.receipt_status == "missing" })
    provenance: {
      phase: $phase
      state: "finished"
      supervisor_exit_code: $code
      batch_id: ($receipt | get -o batch_id)
      harness: ($receipt | get -o harness)
      harness_version: ($receipt | get -o harness_version)
      entries: ($results | get entry)
    }
  }
}

# The engine. base and head are resolved SHAs; the diff is exactly
# tree-to-tree between them. target (optional) records lineage for run.json.
def run-review [
  manifest: path, context: string, base_sha: string, head_sha: string,
  dir: path, target: record = { kind: run }
] {
  let repo = (repo-of $dir)

  let status = (do { ^cue status -C $repo --context $context --json } | complete)
  if $status.exit_code != 0 { die $"context not found in this repository's scope: ($context)" }
  let st = ($status.stdout | from json)

  let m = (load-manifest ($manifest | path expand))

  let diff = (do { ^git -C $repo diff $base_sha $head_sha } | complete)
  if $diff.exit_code != 0 { die $"git diff failed: ($diff.stderr | str trim)" }
  if ($diff.stdout | str trim | is-empty) {
    log $"nothing to review: ($base_sha | str substring 0..9)..($head_sha | str substring 0..9) is empty"
    return 0
  }
  let dirty = (^git -C $repo status --porcelain | str trim)
  if ($dirty | is-not-empty) {
    log "warning: working tree is dirty; uncommitted changes are not reviewed"
  }

  let tmp = (mktemp -t cue-review-diff.XXXXXX)
  $diff.stdout | save -f $tmp
  let added = (do { ^cue add -C $repo --type tmp --context $context --file $tmp review.diff } | complete)
  rm -f $tmp
  if $added.exit_code != 0 { die $"saving diff failed: ($added.stderr | str trim)" }
  let diff_path = ($added.stdout | lines | where {|l| $l | str ends-with "/review.diff" } | last | str trim)
  let run_id = ($diff_path | path dirname | path basename)

  # Lineage record: what was fired, what it resolved to. Never trust older
  # runs' findings just because the context matches.
  let record_file = (mktemp -t cue-review-run.XXXXXX.json)
  mut record = {
    schema_version: 1
    state: "running"
    manifest: { name: ($manifest | path parse | get stem), path: ($manifest | path expand) }
    phases: ($PHASES | each {|phase|
      { phase: $phase, state: "pending", entries: [] }
    })
    target: $target
    base: $base_sha
    head: $head_sha
    context: $st.address
    run_id: $run_id
    diff: $diff_path
  }
  $record | to json | save -f $record_file
  let rec = (do { ^cue add -C $repo --type review --context $context --file $record_file $"($run_id)/run.json" } | complete)
  rm -f $record_file
  if $rec.exit_code != 0 { die $"run record failed: ($rec.stderr | str trim)" 1 }
  let record_path = ([$st.store $st.address review $run_id run.json] | path join)

  let ctx = {
    slug: $context
    address: $st.address
    store: $st.store
    repo: $repo
    run_id: $run_id
    base: $base_sha
    head: $head_sha
    diff: $diff_path
  }
  tag-window { review_context: $context, review_run: $run_id }
  log $"run ($run_id): ($base_sha | str substring 0..9)..($head_sha | str substring 0..9) in ($st.address)"

  mut inputs = []
  mut summary = []
  mut missing = 0
  mut receipt_missing = false
  for phase in $PHASES {
    let entries = ($m | get $phase)
    if ($entries | is-empty) {
      $record.phases = ($record.phases | each {|p|
        if $p.phase == $phase { $p | update state "skipped" } else { $p }
      })
      continue
    }
    let r = (run-phase $ctx $phase $entries $inputs)
    $receipt_missing = ($receipt_missing or $r.receipt_missing)
    $record.phases = ($record.phases | each {|p|
      if $p.phase == $phase { $r.provenance } else { $p }
    })
    $record.state = (if $r.interrupted { "aborted" } else if ($r.produced | is-empty) { "failed" } else { "running" })
    if $record.state != "running" {
      $record.phases = ($record.phases | each {|p|
        if $p.state == "pending" { $p | update state "skipped" } else { $p }
      })
    }
    save-run-record $record_path $record
    $summary = ($summary | append { phase: $phase, produced: $r.produced })
    $missing = $missing + $r.missing
    if $r.interrupted {
      log $"interrupted during ($phase); not starting further phases"
      print-summary $ctx $summary
      return 130
    }
    if ($r.produced | is-empty) {
      log $"phase ($phase) produced no artifacts; stopping"
      print-summary $ctx $summary
      return 1
    }
    $inputs = ($inputs ++ $r.produced)
  }

  $record.state = (if $missing > 0 or $receipt_missing { "incomplete" } else { "completed" })
  save-run-record $record_path $record
  print-summary $ctx $summary
  return (if $missing > 0 or $receipt_missing { 1 } else { 0 })
}

# Take a fully normalized target and either run it here (--foreground) or
# fire a review tmux window. Detached success means accepted, not reviewed.
# t: { kind, base_sha, head_sha, refs, context, title, window, pr? }
def dispatch [repo: path, manifest: path, t: record, --foreground, --force] {
  ensure-context $repo $t.context $t.title $t.parent
  if $foreground {
    exit (run-review $manifest $t.context $t.base_sha $t.head_sha $repo $t)
  }
  if not $force and (running-for $t.context) {
    die $"a review window for ($t.context) is already running; pass --force to fire anyway"
  }
  if ((do { ^tmux has-session -t review } | complete).exit_code != 0) {
    ^tmux new-session -d -s review
  }
  let cmd = $"cue-review run --manifest ($manifest) --context ($t.context) --base ($t.base_sha) --head ($t.head_sha) -C ($repo); exec bash"
  let win = (^tmux new-window -t review -n $t.window -P -F '#{window_id}' $cmd | str trim)
  mut tags = {
    review_target: $t.kind
    review_context: $t.context
    review_title: $t.title
    review_base: ($t.base_sha | str substring 0..9)
    review_head: ($t.head_sha | str substring 0..9)
  }
  if $t.pr? != null { $tags = ($tags | insert review_pr $t.pr) }
  tag-window --target $win $tags
  print $"fired review window: ($t.window) \(($t.context)\) [($t.refs)] run ($win)"
}

def check-single-context [context: any, n: int] {
  if $context != null and $n > 1 {
    die "--context names one context; give it with a single target only"
  }
}

def resolve-parent [parent: any, n: int, repo: path] {
  if $parent == null { return null }
  if $n > 1 { die "--parent requires a single target" }
  let status = (do { ^cue status -C $repo --context $parent --json } | complete)
  if $status.exit_code != 0 { die $status.stderr }
  $status.stdout | from json | get address
}

# Review GitHub PRs by number or branch. gh resolves the PR; refs are
# resolved to SHAs here, before anything detaches.
def "main pr" [
  ...prs: string     # PR numbers or branch names
  --manifest: string = $DEFAULT_MANIFEST  # Manifest name (or path)
  --context: string  # Context slug; default review-<branch-slug>. Single PR only
  --parent: string   # Parent canonical context address for a new context; single target only
  --foreground       # Run in this shell instead of the review tmux session
  --force            # Fire even if a window for the context is already running
  -C: path           # Repository directory (default: current)
] {
  if ($prs | is-empty) { die "give at least one PR number or branch" }
  check-single-context $context ($prs | length)
  let resolved_parent = (resolve-parent $parent ($prs | length) ($C | default $env.PWD | path expand))
  let manifest = (resolve-manifest $manifest)
  let repo = (repo-of ($C | default $env.PWD | path expand))

  mut rc = 0
  for pr in $prs {
    # gh -R wants OWNER/REPO, not a path: run gh from the checkout instead.
    let view = (do { cd $repo; ^gh pr view $pr --json headRefName,baseRefName,title } | complete)
    if $view.exit_code != 0 {
      log $"pr ($pr): gh pr view failed: ($view.stderr | str trim)"
      $rc = 1
      continue
    }
    let info = ($view.stdout | from json)
    let fetch = (do { ^git -C $repo fetch origin $info.headRefName } | complete)
    if $fetch.exit_code != 0 { log $"pr ($pr): fetch failed: ($fetch.stderr | str trim)"; $rc = 1; continue }
    let head_sha = (rev-parse $repo $"origin/($info.headRefName)")
    let base_sha = (merge-base-of $repo $"origin/($info.baseRefName)" $head_sha)
    dispatch $repo $manifest {
      kind: pr
      parent: $resolved_parent
      pr: $pr
      base_sha: $base_sha
      head_sha: $head_sha
      refs: $"($info.baseRefName)..($info.headRefName)"
      context: ($context | default $"review-(slugify $info.headRefName)")
      title: $"Review: ($info.title)"
      window: $"pr-($pr)"
    } --foreground=$foreground --force=$force
  }
  exit $rc
}

# Review a local branch (default: the current branch) before any PR exists.
# Base is the merge-base with the integration ref (--base or origin/HEAD).
# The context name matches the PR context, so a later `pr` reuses it.
def "main branch" [
  ...names: string    # Branch names; default: the current branch
  --base: string      # Integration ref for the merge-base (default: origin/HEAD)
  --manifest: string = $DEFAULT_MANIFEST
  --context: string   # Context slug; default review-<branch-slug>. Single target only
  --parent: string    # Parent canonical context address for a new context; single target only
  --foreground        # Run in this shell instead of the review tmux session
  --force             # Fire even if a window for the context is already running
  -C: path            # Repository directory (default: current)
] {
  let branches = if ($names | is-empty) {
    let cur = (do { ^git -C ($C | default $env.PWD | path expand) rev-parse --abbrev-ref HEAD } | complete)
    if $cur.exit_code != 0 { die $"cannot determine current branch: ($cur.stderr | str trim)" }
    [($cur.stdout | str trim)]
  } else { $names }
  check-single-context $context ($branches | length)
  let resolved_parent = (resolve-parent $parent ($branches | length) ($C | default $env.PWD | path expand))
  let manifest = (resolve-manifest $manifest)
  let repo = (repo-of ($C | default $env.PWD | path expand))
  let integ = (integration-ref $repo $base)

  for name in $branches {
    let head_sha = (rev-parse $repo $name)
    let base_sha = (merge-base-of $repo $integ $head_sha)
    let tail = ($name | split row '/' | last | str substring 0..15)
    dispatch $repo $manifest {
      kind: branch
      parent: $resolved_parent
      base_sha: $base_sha
      head_sha: $head_sha
      refs: $"($integ)..($name)"
      context: ($context | default $"review-(slugify $name)")
      title: $"Review branch ($name)"
      window: $"b-($tail)"
    } --foreground=$foreground --force=$force
  }
}

# The branch a commit belongs to: a local branch containing it (the current
# branch wins ties), else a remote-tracking one. Reviews of commits and
# ranges file into that branch's context so a body of work keeps one
# context instead of fragmenting per-revision ones.
def branch-of [repo: path, sha: string] {
  let local = (do { ^git -C $repo branch --format '%(refname:short) %(HEAD)' --contains $sha } | complete
    | get stdout | lines | each {|l| ($l | parse '{name} {head}' | first) })
  let cur = ($local | where {|b| $b.head == '*' } | get -o name | default [] | first)
  if $cur != null { return $cur }
  let first_local = ($local | get -o name | default [] | first)
  if $first_local != null { return $first_local }
  let remote = (do { ^git -C $repo branch -r --format '%(refname:short)' --contains $sha } | complete
    | get stdout | lines | where {|l| $l != 'origin/HEAD' } | each {|l| $l | str replace -r '^origin/' '' } | first)
  $remote
}

# Review a single commit. Base is its first parent; merge commits review
# against their first parent, root commits are rejected.
def "main commit" [
  ...shas: string     # Commits (SHAs or anything rev-parse resolves)
  --manifest: string = $DEFAULT_MANIFEST
  --context: string   # Context slug; default review-<branch-slug> of the branch containing the commit. Single target only
  --parent: string    # Parent canonical context address for a new context; single target only
  --foreground        # Run in this shell instead of the review tmux session
  --force             # Fire even if a window for the context is already running
  -C: path            # Repository directory (default: current)
] {
  if ($shas | is-empty) { die "give at least one commit" }
  check-single-context $context ($shas | length)
  let resolved_parent = (resolve-parent $parent ($shas | length) ($C | default $env.PWD | path expand))
  let manifest = (resolve-manifest $manifest)
  let repo = (repo-of ($C | default $env.PWD | path expand))

  for sha in $shas {
    let head_sha = (rev-parse $repo $sha)
    let first_parent = (do { ^git -C $repo rev-parse --verify --quiet $"($head_sha)^" } | complete)
    if $first_parent.exit_code != 0 { die $"commit ($sha | str substring 0..9) has no parent (root commit?); use range <empty-tree>..<sha> instead" }
    let base_sha = ($first_parent.stdout | str trim)
    let s10 = ($head_sha | str substring 0..9)
    let br = (branch-of $repo $head_sha)
    if $br == null { die "commit ($s10) is on no branch; pass --context to name one" }
    dispatch $repo $manifest {
      kind: commit
      parent: $resolved_parent
      base_sha: $base_sha
      head_sha: $head_sha
      refs: $"($base_sha | str substring 0..9)..($s10)"
      context: ($context | default $"review-(slugify $br)")
      title: $"Review commit ($s10)"
      window: $"c-($head_sha | str substring 0..6)"
    } --foreground=$foreground --force=$force
  }
}

# Review an explicit commit range, tree-to-tree: exactly what you typed,
# no merge-base substitution. Two-dot syntax only.
def "main range" [
  ...ranges: string   # Ranges as <base>..<head>
  --manifest: string = $DEFAULT_MANIFEST
  --context: string   # Context slug; default review-<branch-slug> of the branch containing the head. Single target only
  --parent: string    # Parent canonical context address for a new context; single target only
  --foreground        # Run in this shell instead of the review tmux session
  --force             # Fire even if a window for the context is already running
  -C: path            # Repository directory (default: current)
] {
  if ($ranges | is-empty) { die "give at least one range as <base>..<head>" }
  check-single-context $context ($ranges | length)
  let resolved_parent = (resolve-parent $parent ($ranges | length) ($C | default $env.PWD | path expand))
  let manifest = (resolve-manifest $manifest)
  let repo = (repo-of ($C | default $env.PWD | path expand))

  for r in $ranges {
    if $r =~ '\.\.\.' { die $"range ($r): three-dot syntax is not supported; this diff is exact, use ($r | str replace '...' '..')" }
    let parts = ($r | split row '..')
    if ($parts | length) != 2 or ($parts | any {|p| $p | is-empty}) {
      die $"range ($r): expected <base>..<head>"
    }
    let base_sha = (rev-parse $repo $parts.0)
    let head_sha = (rev-parse $repo $parts.1)
    let b10 = ($base_sha | str substring 0..9)
    let h10 = ($head_sha | str substring 0..9)
    let br = (branch-of $repo $head_sha)
    if $br == null { die "head ($h10) is on no branch; pass --context to name one" }
    dispatch $repo $manifest {
      kind: range
      parent: $resolved_parent
      base_sha: $base_sha
      head_sha: $head_sha
      refs: $"($b10)..($h10)"
      context: ($context | default $"review-(slugify $br)")
      title: $"Review range ($b10)..($h10)"
      window: $"r-($head_sha | str substring 0..6)"
    } --foreground=$foreground --force=$force
  }
}

# Compat alias: blocking engine call with merge-base semantics, matching the
# historical three-dot behaviour. Prefer the target subcommands.
def "main run" [
  --manifest: string  # Manifest name (or path)
  --context: string  # Existing cue context slug in the repo's scope
  --base: string     # Base ref; the diff is merge-base(<base>,<head>)..<head>
  --head: string = "HEAD"  # Head ref to review
  -C: path           # Repository directory (default: current)
] {
  if $manifest == null { die "--manifest is required" }
  if $context == null { die "--context is required" }
  if $base == null { die "--base is required" }
  let repo = (repo-of ($C | default $env.PWD | path expand))
  let head_sha = (rev-parse $repo $head)
  let base_sha = (merge-base-of $repo $base $head_sha)
  exit (run-review (resolve-manifest $manifest) $context $base_sha $head_sha $repo { kind: run })
}

# State of review windows in the review tmux session.
def "main status" [] {
  if ((do { ^tmux has-session -t review } | complete).exit_code != 0) {
    log "no review session"
    return
  }
  ^tmux list-windows -t review -F "#{@review_state}#{?@review_state,,pending}\t#{window_name}\t#{@review_target}\t#{@review_context}\t#{@review_run}\t#{@review_title}"
  | lines | each {|l| $l | split column "\t" state name target context run title } | flatten
}

def print-summary [ctx: record, summary: list] {
  print $"run_id: ($ctx.run_id)"
  print $"diff: ($ctx.address)/tmp/($ctx.run_id)/review.diff"
  for s in $summary {
    print $"($s.phase):"
    for p in $s.produced {
      print $"  ($ctx.address)/review/($ctx.run_id)/($p | path basename)"
    }
  }
}
