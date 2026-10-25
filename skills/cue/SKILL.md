---
name: cue
description: Manage context, memory and cross-session continuity using the cue protocol.
---

# Agent Memory System (cue)

This skill provides a structured protocol for managing context and continuity
across agent sessions using cue's central store architecture.

## Core Philosophy

Context is the base unit of cue. A context is a container for related
information with its own identity, character, and memory. Everything else
in cue is an artifact inside a context.

The system is organized around four altitudes:

- **WHAT** - `task/`: the primary unit of work. Defined by a goal and a
  completion condition. Namespaced inside a context.
- **WHY** - `spec/`: context or feature specification (`spec/index.md`).
  Defines intent, scope, and what should be true.
- **HOW** - `plan/`: technical approach (`plan/<name>.md`). Subordinate to a
  specific task goal (or a context-level master plan). Contains step-by-step
  progress checkboxes.
- **THINK** - `note/`: idea capture and conversation anchors (`note/<name>.md`
  or nested notes such as `note/ideas/<slug>.md`).

Alongside these four altitudes, a context holds:

- **`trace/`**: markdown artifacts about a revision (hand-offs, diagnostics,
  review walkthroughs) stamped with `repo_id` and `commit_hash`.
- **`review/`**: JSON-native review artifacts (findings, manifests) written
  programmatically; the object's top-level keys are its metadata channel.
- **`bin/`**: executable scripts stored verbatim with the executable bit;
  they carry no metadata.
- **`tmp/`**: path-encoded ephemeral data and external outputs
  (`tmp/<created_at>-<commit_hash>/<filename>`).
- **`log/`**: per-entry chronological milestone stream
  (`log/<timestamp>.json`).

Removed types:

- `todo`: checklists are plans (`plan/`); single deferred obligations are
  tasks (`task/`).
- `doc`: synthesized knowledge lives in `note/` or `spec/`; revision-specific
  artifacts live in `trace/`.

## Frontmatter Management

Markdown artifacts in `cue` use YAML frontmatter as the single source of
truth for metadata. Cue is the sole writer of frontmatter; clients pass
structured fields and never author raw YAML. Frontmatter MUST be preserved
on edits.

### `status:`

Artifacts track lifecycle status: `status: open|in-progress|complete|closed`.

Status is declared on tasks and plans only. Contexts carry NO status field
(see below).

The legacy `inbox` status is removed: captured ideas become notes, and tasks
are created deliberately with defined goals, starting at `open`.

### `priority:`

Bounded priority classification on tasks:
`priority: critical|high|normal|low`. Priority is the only scheduling field.
Contexts carry no priority field.

### `kind:` and `mode:`

Context-level fields on `context.md`, not artifact fields:

- `kind: work|coord|reference` says what ends a context (archival policy):
  - `work`: terminates when its goal is met. Moves through modes.
  - `coord`: terminates when its children terminate. Standing arrangement
    across child contexts or repositories.
  - `reference`: never terminates. An entity: a codebase, a person, a
    domain. It goes cold; it does not complete.
- `mode: research|design|build|review|learn` is an advisory default for the
  behavioural contract a session in that context adopts (see "Session Mode"
  below).

### Contexts Carry No Status

A context is never marked complete; contexts carry no `status` field.
Instead, cue folds what is outstanding (open tasks, unfinished children) and
displays it without asserting completion. A context with nothing outstanding
is quiet, not complete. Reference contexts never count as outstanding.

### Archived Contexts

A context may carry `archived_at` (Unix timestamp) in `context.md`. Archived
contexts are left out of `cue context list` and `cue context tree`, the
pinned views included, unless `--archived` is given. Archiving never moves a
context: its address still resolves for `parent:`, `refs:`, `--context`,
status, render and log.

When a context or reference you expect is missing from a listing, retry with
`--archived` before concluding it does not exist.

### The `repo` Context Convention

Each scope may hold an ordinary context named `repo` (`kind: reference`),
holding information that applies to the repository as a whole (such as
repository-wide idea notes or reference specs). It has no special significance
to cue and is never resolved to automatically; the operator or skills name
`repo` explicitly.

### `parent:`

Exactly one scalar canonical address: `parent: <address>`. For example a child
task `parent: palekiwi/palekiwi/auth/task/login.md`, a plan
`parent: palekiwi/palekiwi/auth/task/login.md`, or a context
`parent: palekiwi/palekiwi/platform`. Never a partial form such as
`plan/index.md`, even when the parent lives in the same context.

Relationships point upward or sideways (child -> parent). Children are derived
by scanning, never declared on the parent.

### `refs:`

Flat list of canonical addresses linking related contexts or artifacts.
Always a YAML list, including when there is exactly one entry:

```yaml
refs:
  - palekiwi/palekiwi/cue-platform-direction/spec/index.md
  - palekiwi/palekiwi/cue-platform-direction/task/migration.md
```

### Auto-Stamped Metadata

- `created_at`: explicitly stamped by cue on all markdown artifacts (Unix
  timestamp).
- `repo_id` and `commit_hash`: stamped by cue on `trace` artifacts to correlate
  them with a specific repository revision.

## Central Store & Context Structure

Memory artifacts live in a single central store at `$CUE_STORE` (default
`~/cue`). Per-repository `.cue/` stores are abolished. Cue writes nothing into
the project working tree.

### Store Layout

```
$CUE_STORE/
  <org>/<repo>/                  # Scope directory derived from git origin remote
    <context-slug>/              # Context directory
      context.md                 # Context descriptor and briefing
      spec/                      # WHY: spec/index.md
      task/                      # WHAT: named task files (<name>.md)
      plan/                      # HOW: named plan files (<name>.md)
      note/                      # THINK: named notes (<name>.md, ideas/<slug>.md)
      trace/                     # REVISION: named traces with repo_id/commit_hash
      review/                    # JSON review artifacts (top-level keys are metadata)
      bin/                       # Executable scripts, stored verbatim
      tmp/                       # Path-encoded ephemeral files (<ts>-<hash>/<file>)
      log/                       # Per-entry milestone JSON files (<ts>.json)
```

### Addressing

- Artifact address: `<scope>/<context>/<type>/<name>`
  (e.g., `palekiwi/palekiwi/cue-platform-direction/spec/index.md`)
- Context address: `<scope>/<context>`
  (e.g., `palekiwi/palekiwi/cue-platform-direction`)

Resolution is direct concatenation against `$CUE_STORE`. There is no slug
search or fallback search path.

### Addresses Are the Only Reference Form

An address is identity; a filesystem path is location. Derive location from
identity, never the reverse:

```
<absolute path> = $CUE_STORE + "/" + <canonical address>
```

Every reference recorded inside an artifact (`parent:`, `refs:`, a log
entry's `trace`) MUST be a full canonical address. Absolute paths and
partial or context-relative forms (`trace/handoff.md`, `plan/index.md`) are
invalid: an absolute path hardcodes one machine's store location, and a
partial form has no meaning outside the artifact that holds it. Both break
store portability and sharing.

When a cue command prints an address, prepend the store root yourself to open
the file. Do not copy a printed absolute path into frontmatter.

### Naming and Paths

The organising rule: **Metadata lives in the artifact. The path carries it only
when the artifact cannot.**

- All markdown artifacts (`task`, `spec`, `plan`, `note`, `trace`) are named
  files at `<type>/<name>.md`.
- No markdown type carries a timestamp or commit hash in its path.
- Non-markdown types keep metadata in-band instead: a `review` object's
  top-level keys are its metadata channel; a `bin` executable carries none.
- The root-versus-point-in-time distinction is deleted.
- `tmp/` is the sole path-encoded type: it holds arbitrary files (diffs,
  binaries, test dumps) under
  `tmp/<created_at>-<commit_hash>/<filename>`.

### Active Context & Scope Resolution

Context resolution order:

1. Explicit `--context <slug>` flag (or harness `context` parameter)
2. `$CUE_CONTEXT` environment variable
3. Current branch configuration: `git config branch.<branch>.cue-context`
4. **unset**

When context is unset:

- **Reads widen to the repository scope** (e.g. `cue list` lists artifacts
  across all contexts in the repository).
- **Writes fail with an error.** Cue has no default or fallback context.

### Context Creation

Because cue has no default or fallback context, a new piece of work begins by
creating its context first:

```bash
cue context create <slug> --title "Title" --kind work --mode design
```

In agent harnesses, use the `cue-context` tool.

### Agent Context Isolation Rules

Agents operate under strict context isolation:

1. **Explicit Context Parameter Required**: Agents MUST explicitly pass
   `context: "<slug>"` on every cue tool call (`cue-add`, `cue-log`, `cue-plan`,
   `cue-task`, etc.) and `--context <slug>` on CLI queries.
2. **Never Mutate Branch Context Associations**: Agents must never run
   `cue context switch` or alter git branch configuration; branch association is
   operator state.
3. **Subagent Scope Propagation**: When delegating work to subagents, the
   primary agent MUST include the context directive in the subagent prompt
   and set `$CUE_CONTEXT` for child processes when supported.

## Artifact Contracts

### `task` (WHAT)

- Primary unit of work; lives at `task/<slug>.md` inside its context.
- Defined by a goal and a completion condition.
- Carries `status: open|in-progress|complete|closed` and `priority: critical|high|normal|low`.
- Namespaced to its context, eliminating global slug collisions.

## Session Mode (`mode:`)

A session's behavioural contract comes from its **mode**, not from the task
it is working on. Mode is a property of the session; the context carries an
advisory default in its `mode:` field.

- **`research`**: Exploration & feasibility analysis.
- **`design`**: Specification, blueprinting & context setup.
- **`build`**: Feature implementation & test execution.
- **`review`**: Code review & evaluation trace generation.
- **`learn`**: Tutoring & capability growth for the user.

Each mode has a corresponding skill carrying its behavioural contract,
expected outputs, and completion rule: `cue-research`, `cue-design`,
`cue-build`, `cue-review`, `cue-learn`.

Resolve the mode in this order and load the matching skill:

1. An explicit instruction from the operator for this session.
2. The active context's `mode:` field (`cue status` prints it).
3. Otherwise infer it from the work at hand and say which mode was assumed.

The context's `kind:` (`work|coord|reference`) selects no skill. It says what
ends the context, which is an archival question rather than a behavioural
one.

### `spec` (WHY)

- Captures intent, scope, and requirements.
- Lives at `spec/index.md` inside its context. Does not contain technical
  implementation details or code snippets.

### `plan` (HOW)

Tracks step-by-step progress using GFM checkboxes (`- [ ]` / `- [x]`).

- Lives at `plan/<name>.md` inside its context.
- Subordinate to a specific task goal, declaring that task's canonical address
  as `parent:`, or serving as a context-level master plan with the context's
  own address as `parent:`.

### `note` (THINK)

- Idea capture, conversation anchors, and exploratory reasoning.
- Lives at `note/<name>.md` or in nested directories such as
  `note/ideas/<slug>.md`.
- Transitions `open` -> `complete` (agreed/incorporated) or `closed` (rejected/dropped).

### `trace`

- Markdown artifact about a specific revision (hand-offs, diagnostics,
  review walkthroughs, branch diffs).
- Lives at `trace/<name>.md`.
- Stamped with `repo_id` and `commit_hash` in frontmatter.
- JSON review payloads are not traces; they belong in `review/`.

### `review`

- JSON-object artifact under `review/<name>.json`, produced
  programmatically by review workflows.
- cue validates only that the payload is a JSON object; findings-schema
  enforcement belongs to the review tooling, not cue.
- Metadata is in-band: `--frontmatter` fields merge as top-level keys of
  the object, never a YAML prefix. No `created_at` or revision stamps.
- Names and nested paths are caller-controlled (e.g.
  `review/<run-id>/findings.json`); extensionless names get `.json`.
- Review artifacts are written with the dedicated `cue-review` tool —
  the only door for the type; `cue-add` does not
  expose it. The CLI keeps `cue add --type review`.

### `bin`

- Executable script stored verbatim: bytes and filename are kept exactly,
  and the file is marked executable.
- Carries no metadata; supplying any is an error, not a silent drop.
- The content is never treated as JSON or reformatted.

## Artifact Lifecycle Operations

- **Creation**: Create new artifacts using available harness tools (`cue-add`,
  `cue-plan`, `cue-task`, etc.) or CLI helpers (`cue add`).
- **Critical Note - Harness Tool Preference**: Always prefer harness-specific
  integration tools (`cue-*`) over raw shell CLI commands when creating artifacts.
  Passing text containing code snippets, symbols, quotes, or backticks directly as
  bash arguments frequently leads to shell escaping failures and corrupted files.
- **Modification**: Update existing artifacts in-place using standard text
  editing tools (`edit`). Never use file overwrite tools that strip or corrupt
  YAML frontmatter.
- **Querying & Discovery**: Discover artifacts exclusively using `cue list` (or
  harness query tools).

## Querying & Discovery (`cue list`)

Always use `cue list` (or harness tools) to discover and inspect artifacts.

### Key Flags & Filtering

- **`--context <slug>`**: Target a specific context. When omitted, queries
  widen across all contexts in the repository scope.
- **`--type <type>` / `-t <type>`**: Filter by category (`task`, `spec`, `plan`,
  `note`, `trace`, `review`, `bin`, `tmp`). Repeatable to match multiple types.
- **`--filter <EXPR>`**: Filter frontmatter expressions (`KEY=VALUE`, `KEY!=VALUE`,
  `KEY~=SUBSTRING`). Dot notation supported (`meta.status=open`). Repeatable (ANDed).
- **`--frontmatter`**: Parse and include YAML frontmatter in JSON output (implies `--json`).
- **`--json` / `-j`**: Output structured JSON.
- **`-C <PATH>` / `--dir <PATH>`**: Run as if started in `<PATH>` (mirrors `git -C`
  for cross-repo queries; resolves scope via that repo's origin remote).
- **`--store <PATH>`**: Root of the central cue store; overrides `$CUE_STORE`.

### Common Discovery Patterns

- **Tasks in active context**: `cue list --context <slug> --type task`
- **All tasks across repository scope**: `cue list --type task`
- **Unfinished tasks in scope**: `cue list --type task --filter "status!=complete" --filter "status!=closed"`
- **Child tasks of a parent**: `cue list --type task --filter "parent=<canonical-address>"`
- **High priority items with frontmatter**: `cue list --context <slug> --type task --filter "priority=high" --frontmatter`
- **List contexts in scope**: `cue context list` or `cue context list --json`

For complete command details and options, see `skills/cue/reference/cli.md`.

## History & Logging (`cue-log`)

Record durable milestones, architectural choices, non-obvious discoveries, and
dead-ends in the context log (`log/<timestamp>.json`).

Log immediately after every git commit and whenever an unexpected discovery or
dead-end occurs during active work. Keep entries high-signal; offload deep
output to companion `trace` artifacts.

- **Title**: Concise summary of the milestone, commit, or discovery.
- **Trace**: Optional canonical address of a trace artifact for deep evidence
  or hand-offs (e.g. `palekiwi/palekiwi/auth/trace/handoff.md`). The
  context-relative form `trace/<name>.md` is rejected.
- **Found**: Surprising discoveries, edge cases, or system quirks (never test
  passes or linter output). Omit if empty.
- **Decided**: Architectural trade-offs, invariants, or abandoned dead-ends
  (never code diffs or renames). Omit if empty.
- **Open**: Unresolved domain ambiguities or external blockers (never
  next-step plan items or workflow actions). Omit if empty.

For routine commits with no new domain learnings or decisions, log only the
milestone title and omit all bullet arrays.

To inspect recent history:

```bash
cue log list --context <slug> --format md --limit 5
```

Recorded activity (associated sessions, commits, created artifacts) is
available with `cue activity list --context <slug> --json`.

When resuming work in a context, read its latest hand-off trace before
acting.

## Operational Discipline

- **Executive Plan Adherence**: Implement current steps in the active executive
  plan incrementally. Update checkboxes (`- [x]`) as steps complete.
- **Scope Compliance**: Implement requested scope only. Capture out-of-scope
  items in `note` or `task` artifacts rather than performing unrequested work.
- **Context Awareness**: Verify active context at session start. Explicitly pass
  context slug on all tool calls and sub-agent handoffs.
- **Central Store Isolation**: Memory artifacts live in `$CUE_STORE`, outside the
  git repository tree. Never attempt to add or commit cue artifacts to the project's
  git repository.

## DOs and DON'Ts

### Frontmatter & Artifact Hygiene

- **DO** use YAML frontmatter as the single source of truth for metadata (`status`, `priority`, `kind`, `parent`, `refs`).
- **DO** update frontmatter `status` to `complete` when all plan/task criteria are met.
- **DO** prefer harness-specific integration tools (`cue-*`) over shell CLI commands when creating artifacts.
- **DO** use the `edit` tool to update existing artifacts in-place.
- **DON'T** prepend markdown headers like `# Status: complete` above or below frontmatter.
- **DON'T** overwrite existing cue artifacts using destructive write tools that strip frontmatter.

### Task & Spec Content

- **DO** keep `task/<slug>.md` concise, focusing on problem context, goals, and completion conditions.
- **DO** keep `spec/index.md` focused purely on scope, requirements, and project intent.
- **DON'T** include technical analysis, implementation details, or code snippets in `spec/index.md`.

### Context & Task Organization

- **DO** create a context first (`cue-context` or `cue context create`) before creating artifacts.
- **DO** store task cards inside their relevant context at `task/<slug>.md`.
- **DO** declare parent links using scalar canonical addresses in `parent:`.
- **DO** write every reference (`parent:`, `refs:`, log `trace`) as a full canonical address, and always write `refs:` as a list.
- **DON'T** record an absolute path or a partial address in an artifact; derive the path from the address at read time instead.
- **DON'T** assume a default or fallback context exists; writes without a context fail.
- **DON'T** use `inbox` status for tasks; triaged tasks start at `open`.

### Execution & Git Discipline

- **DO** discover and inspect artifacts using `cue list` instead of searching the filesystem directly.
- **DO** pass `context: "<slug>"` explicitly on all cue tool calls (`cue-add`, `cue-log`, `cue-plan`, `cue-task`).
- **DO** log after every commit and during active discovery; omit empty fields.
- **DO** resolve all open tasks or capture remaining work before concluding a session.
- **DON'T** log test passes, linter output, or transient plan next-steps in context logs.
- **DON'T** run `cue context switch` or alter git branch configuration (owned exclusively by the human operator).
- **DON'T** search the store directly with `grep` or `find` (use `cue list`).
- **DON'T** attempt to commit cue artifacts in project git commits (the store is external).
- **DON'T** fix unrelated out-of-scope issues during active task execution.

### Style & Formatting

- **DO** keep line lengths under 80 columns (132 columns maximum when readability requires it).
- **DON'T** use emojis in artifacts, code, or logs.
