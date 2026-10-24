import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  activityArgv,
  isGitCommit,
  recordActivity,
  type ActivityCtx,
} from "./activity"

describe("isGitCommit", () => {
  const positives = [
    "git commit -m 'x'",
    "git add . && git commit -m x",
    "git status; git commit",
    "false || git commit --amend",
    "cd repo\ngit commit -m x",
    "GIT_AUTHOR_NAME=a FOO=b git commit -m x",
    "git -C /tmp/repo commit -m x",
    "git -c user.name=a -C ../r commit",
    "  git   commit",
    'git commit -m "fix; git status"',
  ]
  for (const cmd of positives) {
    test(`matches: ${JSON.stringify(cmd)}`, () => {
      expect(isGitCommit(cmd)).toBe(true)
    })
  }

  const negatives = [
    "",
    "git status",
    "git commit-tree HEAD^{tree}",
    'echo "git commit"',
    "echo 'x && git commit'",
    "rg 'git commit' src",
    "git log --grep commit",
    "gitx commit",
    "git -C commit",
    'git -c "a=b" log && echo "; git commit"',
  ]
  for (const cmd of negatives) {
    test(`ignores: ${JSON.stringify(cmd)}`, () => {
      expect(isGitCommit(cmd)).toBe(false)
    })
  }
})

describe("activityArgv", () => {
  test("builds cue activity add with provenance", () => {
    expect(
      activityArgv("a/b/c", "git_commit_attempt", { cwd: "/w" }, "s1"),
    ).toEqual([
      "activity",
      "add",
      "--context",
      "a/b/c",
      "--kind",
      "git_commit_attempt",
      "--details",
      '{"cwd":"/w"}',
      "--harness",
      "pi",
      "--session-id",
      "s1",
    ])
  })
})

function fakes(result: { code: number; stderr?: string } | Error) {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = []
  const notes: [string, string][] = []
  const pi = {
    exec: async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      calls.push({ cmd, args, cwd: opts?.cwd })
      if (result instanceof Error) throw result
      return { stdout: "", stderr: result.stderr ?? "", code: result.code, killed: false }
    },
  } as unknown as ExtensionAPI
  const ctx: ActivityCtx = {
    cwd: "/w",
    hasUI: true,
    ui: { notify: (m: string, l?: string) => void notes.push([m, l ?? ""]) },
    sessionManager: { getSessionId: () => "s1" },
  }
  return { pi, ctx, calls, notes }
}

describe("recordActivity", () => {
  test("runs cue in the session cwd", async () => {
    const f = fakes({ code: 0 })
    await recordActivity(f.pi, f.ctx, "a/b/c", "session_associated", {
      method: "link",
    })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.cmd).toBe("cue")
    expect(f.calls[0]!.cwd).toBe("/w")
    expect(f.calls[0]!.args.slice(0, 4)).toEqual([
      "activity",
      "add",
      "--context",
      "a/b/c",
    ])
    expect(f.notes).toHaveLength(0)
  })

  test("skips without calling cue when there is no address", async () => {
    const f = fakes({ code: 0 })
    await recordActivity(f.pi, f.ctx, undefined, "git_commit_attempt", {})
    expect(f.calls).toHaveLength(0)
  })

  test("nonzero exit warns and does not throw", async () => {
    const f = fakes({ code: 1, stderr: "Error: boom" })
    await recordActivity(f.pi, f.ctx, "a/b/c", "git_commit_attempt", {})
    expect(f.notes).toHaveLength(1)
    expect(f.notes[0]![0]).toContain("boom")
    expect(f.notes[0]![1]).toBe("warning")
  })

  test("exec rejection warns and does not throw", async () => {
    const f = fakes(new Error("spawn failed"))
    await recordActivity(f.pi, f.ctx, "a/b/c", "git_commit_attempt", {})
    expect(f.notes[0]![0]).toContain("spawn failed")
  })
})
