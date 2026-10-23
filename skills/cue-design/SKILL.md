---
name: cue-design
description: |
  Use when the session mode is design, when running a collaborative
  design or specification session, or when the user asks to discuss and refine
  an idea before building it.
---

# Design Sessions

A design session turns a loose problem or proposal into an agreed blueprint. It
is a structured conversation, not a deliverable pipeline or a one-shot spec.

## Core Philosophy

Continuous prose documents force all contained ideas to share a single status.
During active exploration, this causes drift, premature specification, and
confusion between exploratory thinking and settled decisions.

A design context isolates ideas into atomic notes, tracks negative constraints
in a compact invariants file, and defers blueprint assembly until ideas
converge.

## Artifacts of a Design Context

- `note/invariants.md`
  The settled constraints. Lists what the design must NOT contradict (not what
  it must incorporate).
  - Hard limit: under 40 lines (must fit on a single page).
  - Membership test: "If we reversed this, what would have to be re-examined?"
    If nothing downstream breaks, it is a local decision, not an invariant.
  - Authority: Agents may propose invariants; ONLY the operator promotes one.
  - Invariants are revisable. Changing an invariant triggers re-evaluation of
    all dependent ideas.

- `note/ideas/<slug>.md`
  Atomic idea notes. One idea per file.
  - Status: reuses standard cue frontmatter (`status: open | complete | closed`).
    - `open`: Live, under active discussion.
    - `complete`: Agreed and ready to fold into the final blueprint.
    - `closed`: Rejected or dropped.
  - Convention: The first line of body text states the current verdict.
  - Closed notes state the reopen trigger (what evidence or condition would
    reopen discussion).
  - Optional dependency declaration: note dependencies on invariants
    (e.g., `Depends on: invariant:<name>`).

- `spec/index.md`
  The blueprint.
  - Stays empty during exploration.
  - Assembled from `complete` ideas only when the design has converged.

- The context log (`log/`)
  Durable milestone history. Log key architectural discoveries and session
  deltas using `cue-log`.

## Discovery and Querying

Do not rely on injecting all idea notes into prompt context. Agents query and
filter idea notes directly using cue:

- List open ideas: `cue list --context <slug> --type note --filter "status=open"`
- List completed ideas: `cue list --context <slug> --type note --filter "status=complete"`
- List rejected ideas: `cue list --context <slug> --type note --filter "status=closed"`

## The Session Loop

1. **Diverge** (Most of the session)
   - Free brainstorming, critique, and trade-off analysis between operator
     and agent.
   - DO NOT classify status, create idea notes, or ask for verdicts mid-flight.
   - Classifying during brainstorming kills the creative flow.

2. **Harvest** (End of session)
   - The agent summarizes proposed deltas in one pass:
     - New idea notes to create for concepts raised.
     - Status transitions for existing ideas (`open` -> `complete` / `closed`).
     - Reopen triggers for closed ideas.
   - The operator confirms or corrects the batch in a single interaction.

3. **Promote** (Rare)
   - Fundamental constraints that pass the membership test are proposed for
     `note/invariants.md`.
   - Promoted ONLY upon explicit confirmation by the operator.

## Completion

A design task is complete when:
- No ideas remain `open` (all are `complete`, `closed`, or explicitly deferred).
- `spec/index.md` is assembled from the `complete` ideas and verified.
- The operator explicitly confirms the design has converged.

## Anti-patterns

- Writing `spec/index.md` prematurely on the first turn.
- Storing multiple independent ideas in a single prose note or register.
- Asking the operator to classify or confirm status after every single exchange.
- Promoting invariants without explicit operator sign-off.
- Inventing custom status names instead of using standard cue frontmatter.
