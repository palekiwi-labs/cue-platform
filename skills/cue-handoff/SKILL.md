---
name: cue-handoff
description: |
  Execute a clean hand-off to a successor agent when context saturation bounds
  are reached or when ending a session mid-task. Use when stopping work that
  another agent will resume.
---

# Cue Hand-Off Protocol

A hand-off ends a session cleanly so a fresh agent can resume the task
with no lost context. Run this deterministic closing sequence in order;
do not start new work once the sequence begins.

## Context Saturation

Reasoning quality degrades as a session's context grows, and every
session has finite capacity. The `cue-log` tool reports the session's
context state at the end of each entry. When that note says the session
is above the soft saturation limit, the remaining context is no longer
reliable for substantial work: hand off via this skill instead of
starting anything new. Above the hard limit, stop editing and hand off
immediately. Handing off is a normal part of the workflow, not a
failure.

## Closing Sequence

1. **Stop new work**: finish the current atomic step (commit and log), or
   safely back out of half-broken edits. Start nothing new.
2. **Reconcile plans and tasks**: mark completed items `- [x]`; ensure
   partially done items state remaining sub-items. Ensure any deferred
   obligations are captured as tasks (`task/`).
3. **Persist a hand-off trace**:
   - Reference existing artifacts (specs, plans, logs) by path instead of
     duplicating their content.
   - Record exact file locations for in-flight changes (`path:line`).
   - Detail uncommitted state (staged, unstaged, untracked).
   - List explicit "Next Steps for Successor Agent".
4. **Emit the final hand-off summary** to the operator: stopping point,
   state of the master plan, committed vs uncommitted
   work, and the first action the successor should take.
