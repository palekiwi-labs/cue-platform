---
name: cue-log-compact
description: |
  Compacts accumulated chronological log entries into high-level milestone summaries
  while archiving originals in .archive/. Use when the log in a context has grown large,
  when prompt token limits are pressured by log history, or when executing log compaction.
---

# Cue Log Compaction Protocol

Log compaction condenses an accumulated chronological stream of per-entry
milestone logs (`log/<timestamp>.json`) into high-level summary entries, while
preserving the original entries byte-for-byte in an archive directory.

Compaction reduces prompt context consumption during session initialization
while safeguarding historical fidelity, architectural trade-offs, and
reversibility.

## Core Invariants

1. **Lossless Storage, Lossy Volume**: Original log entries are never discarded
   or rewritten in place. They are moved into an archive directory. The rendered
   log shrinks; the stored history remains complete.
2. **Recency Protection by Construction**: Context recency is defined as the
   newest log filename (`max(filename)` in `log/`). A compaction **must never
   include the newest entry** in `log/`. Compacting only historical slices
   guarantees that recency is untouched without requiring special naming.
3. **Preserve Reversibility**: The summary entry is named after the end of the
   compacted range (`<t_end>.json`). Restoring the archived entries over `log/`
   automatically overwrites the summary, making uncompaction clean and idempotent.
4. **No False Sharpening**: A summary entry must never convert a hedged,
   deferred, or contested decision into a settled one. If an entry recorded a
   question as reopened or undecided, the summary preserves that exact qualification.

## File and Directory Layout

Archived entries reside in a dedicated directory per compacted range:

```
$CUE_STORE/<scope>/<context>/log/
├── <t_end>.json                    <- Compaction summary entry
├── <t_recent_1>.json               <- Live, uncompacted entries
├── <t_recent_2>.json
└── .archive/
    └── <t_start>-<t_end>/
        ├── manifest.json           <- Machine-readable archive manifest
        ├── <t_start>.json          <- Original entries (byte-identical)
        ├── ...
        └── <t_end>.json
```

Because `cue log list` reads only immediate files in `log/` with `.json`
extension, the `.archive/` directory is completely invisible to log rendering.

### The `manifest.json` Record

Every archive directory carries a `manifest.json` detailing the compacted range:

```json
{
  "from": 1789133828399767010,
  "to": 1789133828399769010,
  "count": 3,
  "compacted_at": 1789140000000000000,
  "summary": "log/01789133828399769010.json",
  "entries": [
    {
      "file": "01789133828399767010.json",
      "title": "Opened cue platform direction umbrella",
      "trace": null
    }
  ]
}
```

## Summary Entry Specification

The summary entry is a standard `StoredLogEntry` placed at `log/<t_end>.json`:

- **Filename**: Zero-padded 20-digit integer `<t_end:020>.json`, matching the
  last entry of the compacted slice.
- **`timestamp`**: Matches `<t_end>`. In cue, the filename is the sort key;
  keeping the `timestamp` field in sync prevents drift.
- **`commit_hash`**: The real commit hash from `<t_end>`. Never use a synthetic
  sentinel token (e.g. `compacted`), which breaks rendering and pattern matches.
- **`title`**: `Compacted <N> entries: <phase description>`.
  Keep descriptions high-level. Do not embed full 20-digit timestamps in titles
  to conserve the 120-character title limit.
- **`trace`**: Link to an existing phase-closing hand-off or diagnostic trace
  (e.g. `trace/handoff-design-session.md`). Do **not** generate a redundant
  markdown concatenation of the archived log entries.
- **`compacted` Block**: Forward-compatible metadata block documenting the range:
  ```json
  "compacted": {
    "from": 1789133828399767010,
    "to": 1789133828399769010,
    "count": 3,
    "archive": "log/.archive/01789133828399767010-01789133828399769010"
  }
  ```

## Content Synthesis Rules

The log's purpose after compaction is recording why directions changed,
what failed, and what operational surprises occurred. The blueprint
(`spec/index.md`) and idea notes (`note/ideas/`) already hold the settled model.

### 1. `found`
- **Keep**:
  - Surprising facts that invalidated prior decisions.
  - Hard system or tool behaviors (e.g. EPIPE panics, CLI parsing quirks,
    Docker bind mount permissions).
  - Concrete performance measurements or file censuses.
  - File paths and line numbers (`path:line`) that pinpoint discoveries.
- **Drop**:
  - Transient findings whose only purpose was justifying decisions now in `spec/`.

### 2. `decided`
- **Keep**:
  - Architectural reversals and what caused them.
  - Rejected alternatives along with their explicit reopen triggers.
  - Departures from previous patterns.
- **Replace Settled Decisions with a Pointer**:
  Add one standard pointer bullet instead of restating settled specifications:
  `- "The model itself is in spec/index.md and the argument for each piece in note/ideas/; this summary does not restate them."`

### 3. `open`
- **Recompute against Current Reality**:
  Do not copy historical open questions that were subsequently resolved.
  Check currently active open lists in `spec/index.md` and `plan/index.md`.
  Only carry forward items that are still genuinely unresolved today.

## Step-by-Step Compaction Workflow

When executing a compaction manually or via script:

1. **Partition the Log into Phases**:
   Identify natural phase boundaries ending at major milestones or hand-offs.
   Leave the active tail (current session and recent in-flight work) uncompacted.
2. **Verify Contiguity and Safety**:
   Ensure the range is contiguous and does not include the newest log entry.
3. **Author the Summary Entries**:
   Apply synthesis rules to create the summary JSON for each phase.
4. **Stage and Archive**:
   - Create `log/.archive/<t_start>-<t_end>/`.
   - Write `manifest.json`.
   - Copy original entries byte-for-byte into the archive folder (preserving
     non-standard keys like `body`).
   - Remove original entries from `log/`.
   - Write the summary entry to `log/<t_end>.json`.
5. **Verify Rendering**:
   Run `cue log list --context <context> --format md` to ensure chronological
   order, correct markdown rendering, and working trace links.

## Reversibility (Uncompaction)

To restore an archived range back to the active log:

```bash
# 1. Copy archived originals back into log/ (overwrites the summary file <t_end>.json)
cp -p "$LOG_DIR/.archive/$RANGE"/*.json "$LOG_DIR/"

# 2. Remove the archive directory
rm -rf "$LOG_DIR/.archive/$RANGE"
```

Because the summary entry filename matches `<t_end>.json`, copying originals
back immediately replaces the summary without leaving duplicate or orphan files.
