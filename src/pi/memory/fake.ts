/**
 * Static fake memory data, so the monitor can be built and reviewed before
 * the reflection pipeline produces real output. Delete before the pipeline
 * is deployed.
 */

import type { MemoryCommit, MemoryLevel, MemorySource, ReflectionRun } from "./model"

const MIN = 60_000

function fakeLevels(): MemoryLevel[] {
  return [
    {
      label: "user",
      path: "user",
      files: [
        {
          path: "user/MEMORY.md",
          content: [
            "# User memory",
            "",
            "- Prefers lists over tables in all markdown output.",
            "- Wants zero implementation comments in code.",
            "- Commits granularly; logs a cue entry after each commit.",
            "",
          ].join("\n"),
        },
        {
          path: "user/review-style.md",
          content: [
            "# Review style",
            "",
            "- Asks for diff-anchored findings, not general advice.",
            "- Rejects findings that restate the code.",
            "",
          ].join("\n"),
        },
      ],
    },
    {
      label: "coordinating",
      path: "scopes/palekiwi/palekiwi",
      files: [
        {
          path: "scopes/palekiwi/palekiwi/MEMORY.md",
          content: [
            "# palekiwi/palekiwi",
            "",
            "- cue-platform features merge into dev with --no-ff; never rebase dev.",
            "- The agent VM never pushes; the operator fetches from the vm remote.",
            "",
          ].join("\n"),
        },
      ],
    },
    {
      label: "scope",
      path: "scopes/palekiwi-labs/cue-platform",
      files: [
        {
          path: "scopes/palekiwi-labs/cue-platform/MEMORY.md",
          content: [
            "# palekiwi-labs/cue-platform",
            "",
            "- Run `bun run typecheck` and `bun test ./src` before committing.",
            "- Browsers take their data through a deps object; views only render.",
            "",
          ].join("\n"),
        },
      ],
    },
  ]
}

function fakeRuns(now: number): ReflectionRun[] {
  return [
    {
      id: "r-7f3a",
      sessionId: "5d1c9e2a-0b7e-4f0e-9a51-3c2d8e1f6a40",
      trigger: { kind: "cue-log", title: "v1 task and plan written" },
      state: "running",
      model: "google/gemini-3.8-flash",
      started: now - 1 * MIN,
      log: [
        "worktree: /tmp/cue-memory-wt/r-7f3a",
        "snapshot: 3 levels, 4 files, 1.2 KB",
        "transcript: 214 turns trimmed to 38",
        "tool: read user/MEMORY.md",
      ],
    },
    {
      id: "r-6e21",
      sessionId: "a2f4b6c8-1d3e-4f5a-8b7c-9d0e1f2a3b4c",
      trigger: { kind: "cue-log", title: "Context created; v1 scope agreed" },
      state: "done",
      outcome: "committed",
      model: "google/gemini-3.8-flash",
      started: now - 42 * MIN,
      durationSecs: 74,
      log: [
        "worktree: /tmp/cue-memory-wt/r-6e21",
        "snapshot: 3 levels, 3 files, 0.9 KB",
        "tool: edit user/MEMORY.md",
        "tool: write user/review-style.md",
        "commit: memory: note review style preferences",
        "merge: fast-forward main",
      ],
    },
    {
      id: "r-5c90",
      sessionId: "a2f4b6c8-1d3e-4f5a-8b7c-9d0e1f2a3b4c",
      trigger: { kind: "manual" },
      state: "done",
      outcome: "no_changes",
      model: "google/gemini-3.8-flash",
      started: now - 3 * 60 * MIN,
      durationSecs: 31,
      log: [
        "worktree: /tmp/cue-memory-wt/r-5c90",
        "snapshot: 3 levels, 2 files, 0.6 KB",
        "report: nothing durable in this session",
      ],
    },
    {
      id: "r-4b12",
      sessionId: "0f9e8d7c-6b5a-4f3e-2d1c-0b9a8f7e6d5c",
      trigger: { kind: "cue-log", title: "Reflector prompt tuned" },
      state: "done",
      outcome: "failed",
      error: "uncommitted changes",
      model: "google/gemini-3.8-flash",
      started: now - 26 * 60 * MIN,
      durationSecs: 58,
      log: [
        "worktree: /tmp/cue-memory-wt/r-4b12",
        "tool: edit scopes/palekiwi-labs/cue-platform/MEMORY.md",
        "finalize: worktree has uncommitted changes",
      ],
    },
  ]
}

const DIFFS: Record<string, string> = {
  b41d2e9: [
    "commit b41d2e9",
    "    memory: note review style preferences",
    "",
    " user/MEMORY.md        | 1 +",
    " user/review-style.md  | 4 ++++",
    "",
    "diff --git a/user/MEMORY.md b/user/MEMORY.md",
    "--- a/user/MEMORY.md",
    "+++ b/user/MEMORY.md",
    "@@ -3,3 +3,4 @@",
    " - Prefers lists over tables in all markdown output.",
    " - Wants zero implementation comments in code.",
    "+- Commits granularly; logs a cue entry after each commit.",
    "diff --git a/user/review-style.md b/user/review-style.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/user/review-style.md",
    "@@ -0,0 +1,4 @@",
    "+# Review style",
    "+",
    "+- Asks for diff-anchored findings, not general advice.",
    "+- Rejects findings that restate the code.",
  ].join("\n"),
  "93ac07f": [
    "commit 93ac07f",
    "    chore: initialize memory repo",
    "",
    " coordinating.json | 1 +",
    " scopes/MEMORY.md  | 4 ++++",
    " user/MEMORY.md    | 4 ++++",
  ].join("\n"),
}

function fakeCommits(now: number): MemoryCommit[] {
  return [
    {
      hash: "b41d2e9",
      time: now - 41 * MIN,
      subject: "memory: note review style preferences",
      files: ["user/MEMORY.md", "user/review-style.md"],
    },
    {
      hash: "93ac07f",
      time: now - 2 * 24 * 60 * MIN,
      subject: "chore: initialize memory repo",
      files: ["coordinating.json", "scopes/MEMORY.md", "user/MEMORY.md"],
    },
  ]
}

export function fakeSource(now = Date.now()): MemorySource {
  return {
    root: "~/cue-memory (fake data)",
    levels: async () => fakeLevels(),
    runs: async () => fakeRuns(now),
    commits: async () => fakeCommits(now),
    show: async (hash) => DIFFS[hash],
  }
}
