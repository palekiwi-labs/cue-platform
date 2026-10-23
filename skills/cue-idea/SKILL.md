---
name: cue-idea
description: |
  Capture an idea as an open cue note in the inbox context.
  Use when the user runs /idea or asks to capture a thought or idea.
---

# Cue Idea Capture

Capture ideas as **open notes** in the repository's `inbox` context. Capture is
not implementation—never create a task or start building.

## Destination

- Target context: `inbox` in the current repository scope (`kind: reference`).
- If `inbox` does not exist in this scope, create it first using `cue-context`
  (`name: "inbox"`, `kind: "reference"`, `title: "Inbox"`).

## Protocol

1. **Check for duplicates via `@explore`**:
   Delegate search to the `@explore` subagent to avoid polluting the main
   session with search noise:
   - Task: check if an existing note covers this idea.
   - Return only: "No match" or "Candidate: <address> - <summary>".
   - If a match exists, report it and ask whether to update that note.

2. **Capture the note**:
   - Write via `cue-add`:
     - `context: "inbox"`
     - `type: "note"`
     - `filename: "<kebab-slug>.md"`
     - `frontmatter: { status: "open" }`
     - `content`: concise summary of the idea and why it came up.

3. **Report & Stop**:
   - Report the canonical address (`<scope>/inbox/note/<slug>.md`) and stop.
