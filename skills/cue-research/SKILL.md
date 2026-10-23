---
name: cue-research
description: |
  Use when the session mode is research, or when performing technical
  exploration and investigation in any session.
---

# Research Sessions & Exploration

Research answers open questions and tests hypotheses. It produces durable
knowledge and evidence, not feature implementation code or target
specifications.

## Purpose and Outputs

- **Purpose**: Explore ideas, evaluate tools and dependencies, test
  hypotheses, and answer technical unknowns.
- **Outputs**:
  - **Diagnostic Traces (`trace/`)**: Raw evidence, benchmark logs, CLI
    outputs, error logs, reproduction steps, and revision-specific findings
    (stamped with `repo_id` and `commit_hash`).
  - **Durable Notes (`note/`)**: Synthesized findings, trade-off
    analyses, architecture reference, tool/crate evaluations, and decision
    context (`note/<name>.md`).

### When to Use `trace/` vs `note/`

- **`trace/` — Raw Evidence & Revision Observations**:
  - Point-in-time snapshots captured during active discovery, benchmark runs,
    or commit inspections.
- **`note/` — Synthesized & Durable Knowledge**:
  - Stable, structured reference documents (`note/<name>.md`).
  - Distills raw traces and learnings into durable knowledge (e.g.,
    architecture breakdowns, library comparisons, design trade-offs)
    intended to guide future work across sessions.

## Prior Context Discovery

Before opening new research paths, check if relevant research or context
already exists to avoid redundant work:

1. **Current Context**: Query existing artifacts for the active context
   (`cue list --context <slug> -t note`, `cue list --context <slug> -t trace`).
2. **Repository Scope**: Search across all contexts in the repository scope
   (`cue list -t note`, `cue list -t trace`).

**Code Drift Caution**: Treat existing artifacts as valuable orientation
and hints, but always verify critical findings against current source code as
codebases evolve.

## Execution Strategy: Breadth-First, Depth-Second

1. **Scout First (Breadth)**: Map the high-level landscape before diving into
   specifics. Understand directory structure, core abstractions, and main
   entry points. Never launch deep investigations into an unfamiliar
   repository without initial scouting.
2. **Targeted Deep Dives (Depth)**: Once the terrain is mapped and key
   questions are framed, conduct focused deep-dive investigations on specific
   paths, files, or dependencies.

## Delegation & Orchestration

- **Protect Primary Context Window**: Processing large volumes of source code,
  raw logs, or external docs rapidly saturates context.
- **Orchestrate Sub-Agents**: The primary agent acts as manager — framing
  target questions, delegating focused sub-tasks to sub-agents, and
  gathering summaries for final synthesis.

## Boundaries

- Do not write feature implementation code.
- Do not draft target repository specifications.
