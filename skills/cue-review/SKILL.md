---
name: cue-review
description: |
  Review sessions and the cue-review CLI. Use when the session mode is
  review, when the operator asks to review a PR or branch, start or check
  review runs, or discuss/triage review findings.
---

# Review Sessions

A review session evaluates work it did not produce. It usually lives in a
dedicated review context and drives the `cue-review` CLI (on PATH in
every cast container), which orchestrates multi-agent reviews
(reviewers -> merge -> verify) via cue-agent and saves findings as cue
review artifacts.

## Purpose and Outputs

- **Purpose**: Inspect diffs, analyse quality and correctness, record and
  verify findings, and triage them to resolution.
- **Outputs**: Review artifacts (`review/<RUN_ID>/`), traces (`trace/`),
  and milestone history (the context log).

## Boundaries

- Operates separately from `build` to avoid self-review bias.
- Record findings; do not silently fix them while reviewing. Addressing
  agreed findings is follow-up build work.

## Lifecycle

1. **Context**: one review context per target, `review-<branch-slug>`
   (`cue context create ... --mode review`, or let cue-review create it).
   Sessions reviewing that work link/switch to it. Never run
   `cue context switch` for the operator; create or name it explicitly.
2. **Run**: fire the pipeline, do not babysit it. One command per review
   target; all are detached by default (a window in the `review` tmux
   session) and return immediately:

       cue-review pr 123 [124 ...]     [--context <slug>] [-C <dir>]
       cue-review branch [<name>]     [--base <integration-ref>] [-C <dir>]
       cue-review commit <sha>        [-C <dir>]
       cue-review range <base>..<head> [-C <dir>]

   - `pr`: resolves via `gh`, fetches refs. Context `review-<branch-slug>`.
   - `branch` (no name = current branch): pre-PR review, no gh needed.
     Base is the merge-base with `origin/HEAD` (or `--base`). Context
     `review-<branch-slug>` — the same context `pr` uses later, so
     pre-PR and PR reviews share history.
   - `commit`: reviews one commit against its first parent.
   - `range`: exact tree-to-tree diff of the two commits, no merge-base
     substitution.

   All targets share the context naming scheme: `review-<branch-slug>`
   of the branch the reviewed head belongs to (current branch first,
   then any local, then remote-tracking). One body of work, one context;
   pass `--context` to override (e.g. a commit with no branch).

   Refs are resolved to SHAs before anything detaches. Windows are named
   `pr-<N>` / `b-<tail>` / `c-<sha>` / `r-<sha>` and tagged with the
   context, title, target kind and SHAs. `--foreground` blocks (summary
   on stdout) only on explicit request; `--force` fires past a window
   already running for the same context; `--context` overrides the
   automatic name (single target only).

   All four targets accept `--parent <org>/<repo>/<context>` (single
   target only). When operating inside a feature work context, pass
   `--parent <current-context-address>` to link the new review context
   to that work. The parent applies only when creating a context;
   existing contexts are reused without changing their parent.

   Manifests are selected by name: `--manifest <name>` reads
   `~/.config/cue/review/<name>.json` (global only; project-specific
   ones are name-prefixed, e.g. `spabreaks-...`). Default `default`
   (reviewers opus+sol, merger sol, verifier opus; ~$0.5, minutes/PR).
   Other manifests: `unslop` (AI-slop check against the slop registry,
   one cheap reviewer, no verify; use when asked for an unslop or slop
   review). List all with `ls ~/.config/cue/review/*.json`; pick the one
   the operator names, else `default`.
3. **Collect**: `cue-review status` lists windows with
   `@review_state` (running/ok/failed/pending). When `ok`, read:
   - findings: `<scope>/<context>/review/<RUN_ID>/verifiers-<name>.json`
     (verified findings; refuted ones stay, marked dismissed)
   - merge list `merge-<name>.json`; raw reviews `reviewers-<name>.json`
   - run record `run.json`: check target and resolved SHAs first; older
     runs may review a different revision. Version 1 records manifest,
     phase/entry inputs and artifacts, receipt metrics and errors, and
     bounded observed model/tool activity. `receipt.model` is
     configuration-first; `observed.models` comes from runtime events.
     Missing receipts/streams are explicit, not zero-cost/no-activity.
     `observed.requests` are tool requests, not proof of files read or
     comprehension. Resolve finding `source_ids` to entry artifact paths
     for provenance; new agent artifacts do not repeat model metadata.
   - diff `<scope>/<context>/tmp/<RUN_ID>/review.diff`; traces `trace/agent/`

   RUN_ID is unique per run; the newest `review/<RUN_ID>/` supersedes
   older ones and serves as the actionable backlog.
4. **Discuss and triage**: walk findings with the operator
   (`file:line_start-line_end` locations). Triage means updating a
   finding's `status` (`applied`) or `dismiss_reason` (`dismissed`)
   in place in the latest verifier artifact. Agent artifacts otherwise
   stay immutable. The runner alone atomically updates `run.json` after
   each phase; never edit its provenance during triage. Addressing agreed
   findings happens as normal
   build work afterwards, logged as milestones.

Interrupted runs (window state `failed`, exit 130) may hold partial
artifacts. A hard interruption can leave `run.json` at its last completed
phase with state `running`; this is not proof of a live process or clean
cleanup. A reported abort is recorded as `aborted`; later phases are
skipped. Failed/incomplete runs may also contain usable artifacts.
