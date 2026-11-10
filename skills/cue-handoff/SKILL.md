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
3. **Write the hand-off trace** (see "Hand-Off Trace" below).
4. **Log the hand-off** with `cue-log`, attaching the trace by its
   canonical address.
5. **Emit the final hand-off summary** to the operator: stopping point,
   state of the master plan, committed vs uncommitted
   work, and the first action the successor should take.

## Hand-Off Trace

When a session starts working in the context, the latest hand-off is
injected in full. It is the successor's first briefing, so write it for
that moment.

- **Name**: `trace/handoff-<slug>.md`. Only traces named `handoff-*`
  are recognised as hand-offs; the newest one is injected.
- **Open with state and the first next step**: where the work stands
  and the single action the successor should take first.
- **Then, only as needed**: in-flight changes with exact locations
  (`path:line`), uncommitted state (staged, unstaged, untracked),
  remaining steps, and non-obvious facts the successor would otherwise
  rediscover.
- **Point, do not copy**: reference specs, plans, tasks and log entries
  by canonical address. The injection already lists them and shows the
  log tail.
- **Keep it short**: aim for well under 100 lines. Injection truncates
  at 300.
- **Self-contained**: no references to this session's conversation.

## Resuming From a Hand-Off

- The injected hand-off shows how many log entries came after it; read
  those before trusting it.
- When the work it describes is done, say so in a log entry naming the
  hand-off's address.
- If you stop mid-work again, write a new hand-off rather than leaving
  the old one as the latest.
