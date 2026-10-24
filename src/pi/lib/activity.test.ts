import { describe, expect, test } from "bun:test"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import {
  activityArgv,
  commitDirs,
  commitLines,
  isGitCommit,
  originScope,
  recordActivity,
  registerActivityRecording,
  type ActivityCtx,
} from "./activity"
import { CUE_CONTEXT_TYPE } from "./current-context"

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
      activityArgv("a/b/c", "git_commit", { cwd: "/w" }, "s1"),
    ).toEqual([
      "activity",
      "add",
      "--context",
      "a/b/c",
      "--kind",
      "git_commit",
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
    await recordActivity(f.pi, f.ctx, undefined, "git_commit", {})
    expect(f.calls).toHaveLength(0)
  })

  test("nonzero exit warns and does not throw", async () => {
    const f = fakes({ code: 1, stderr: "Error: boom" })
    await recordActivity(f.pi, f.ctx, "a/b/c", "git_commit", {})
    expect(f.notes).toHaveLength(1)
    expect(f.notes[0]![0]).toContain("boom")
    expect(f.notes[0]![1]).toBe("warning")
  })

  test("exec rejection warns and does not throw", async () => {
    const f = fakes(new Error("spawn failed"))
    await recordActivity(f.pi, f.ctx, "a/b/c", "git_commit", {})
    expect(f.notes[0]![0]).toContain("spawn failed")
  })
})

describe("commitLines", () => {
  test("parses branch, root-commit and detached HEAD lines", () => {
    const out = [
      "[dev 6c9688b] feat: thing",
      " 2 files changed, 3 insertions(+)",
      "[master (root-commit) 4fa6186] init",
      "[detached HEAD 1a2b3c4] wip [x]",
    ].join("\n")
    expect(commitLines(out)).toEqual([
      { short: "6c9688b", branch: "dev", title: "feat: thing" },
      { short: "4fa6186", branch: "master", title: "init" },
      { short: "1a2b3c4", branch: null, title: "wip [x]" },
    ])
  })

  test("ignores lines that are not commit summaries", () => {
    expect(commitLines("")).toEqual([])
    expect(commitLines("nothing to commit, working tree clean")).toEqual([])
    expect(commitLines("  [dev 6c9688b] indented")).toEqual([])
    expect(commitLines("[dev xyz1234] not hex")).toEqual([])
  })
})

describe("commitDirs", () => {
  test("session cwd by default", () => {
    expect(commitDirs("git commit -m x", "/w")).toEqual(["/w"])
  })

  test("follows cd segments and -C options", () => {
    expect(commitDirs("cd /tmp/a && git commit -m x", "/w")).toEqual(["/tmp/a"])
    expect(commitDirs("cd sub; git -C ../r commit", "/w")).toEqual(["/w/r"])
    expect(
      commitDirs("git -C /x commit && cd /y && git commit", "/w"),
    ).toEqual(["/x", "/y"])
  })

  test("deduplicates and skips non-commit segments", () => {
    expect(commitDirs("git commit; git status; git commit", "/w")).toEqual(["/w"])
    expect(commitDirs("git status", "/w")).toEqual([])
  })
})

describe("originScope", () => {
  test("derives org/repo like cue", () => {
    expect(originScope("git@github.com:palekiwi-labs/cue.git")).toBe("palekiwi-labs/cue")
    expect(originScope("https://github.com/palekiwi/palekiwi")).toBe("palekiwi/palekiwi")
    expect(originScope("/srv/git/org/repo.git/")).toBe("org/repo")
    expect(originScope("repo")).toBeNull()
  })
})

describe("registerActivityRecording", () => {
  type Handler = (e: unknown, ctx: ExtensionContext) => Promise<void>
  const FULL = "6c9688b0000000000000000000000000000000aa"
  function setup(linked?: string, git: Record<string, string> = {}) {
    const handlers: Record<string, Handler> = {}
    const calls: string[][] = []
    const gitCalls: { args: string[]; cwd?: string }[] = []
    const pi = {
      on: (event: string, h: Handler) => {
        handlers[event] = h
      },
      exec: async (cmd: string, args: string[], opts?: { cwd?: string }) => {
        if (cmd === "git") {
          gitCalls.push({ args, cwd: opts?.cwd })
          const key = `${opts?.cwd} ${args.join(" ")}`
          const out = git[key]
          return out === undefined
            ? { stdout: "", stderr: "fatal", code: 128, killed: false }
            : { stdout: out + "\n", stderr: "", code: 0, killed: false }
        }
        calls.push(args)
        return { stdout: "", stderr: "", code: 0, killed: false }
      },
    } as unknown as ExtensionAPI
    const ctx = {
      cwd: "/w",
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () =>
          linked
            ? [{ type: "custom", customType: CUE_CONTEXT_TYPE, data: { address: linked } }]
            : [],
      },
    } as unknown as ExtensionContext
    registerActivityRecording(pi)
    const fire = (e: object) =>
      handlers["tool_result"]!(
        { type: "tool_result", toolCallId: "t", content: [], isError: false, ...e },
        ctx,
      )
    const start = (e: object) =>
      handlers["tool_call"]!({ type: "tool_call", toolCallId: "t", ...e }, ctx)
    return { fire, start, calls, gitCalls, git }
  }
  const repoGit = (dir: string) => ({
    [`${dir} rev-parse --verify --quiet 6c9688b^{commit}`]: FULL,
    [`${dir} rev-parse --show-toplevel`]: dir,
    [`${dir} remote get-url origin`]: "git@github.com:o/r.git",
  })
  const text = (t: string) => [{ type: "text", text: t }]

  test("records a verified git_commit from the output", async () => {
    const s = setup("a/b/c", repoGit("/w"))
    await s.fire({
      toolName: "bash",
      input: { command: "git add . && git commit -m x" },
      content: text("[dev 6c9688b] feat: x\n 1 file changed"),
    })
    expect(s.calls).toEqual([
      activityArgv(
        "a/b/c",
        "git_commit",
        { hash: FULL, branch: "dev", title: "feat: x", repo: "o/r", root: "/w" },
        "s1",
      ),
    ])
  })

  test("records even when the call reports an error", async () => {
    const s = setup("a/b/c", repoGit("/w"))
    await s.fire({
      toolName: "bash",
      isError: true,
      input: { command: "git commit -m x && false" },
      content: text("[dev 6c9688b] x"),
    })
    expect(s.calls).toHaveLength(1)
  })

  test("resolves the hash in the cd target", async () => {
    const s = setup("a/b/c", repoGit("/tmp/r"))
    await s.fire({
      toolName: "bash",
      input: { command: "cd /tmp/r && git commit -m x" },
      content: text("[master (root-commit) 6c9688b] x"),
    })
    expect(s.calls).toHaveLength(1)
    expect(JSON.parse(s.calls[0]![7]!)).toMatchObject({ root: "/tmp/r", branch: "master" })
  })

  test("repo is null without an origin remote", async () => {
    const git = repoGit("/w")
    delete git["/w remote get-url origin"]
    const s = setup("a/b/c", git)
    await s.fire({ toolName: "bash", input: { command: "git commit" }, content: text("[dev 6c9688b] x") })
    expect(JSON.parse(s.calls[0]![7]!).repo).toBeNull()
  })

  test("nested calls are recorded too", async () => {
    const s = setup("a/b/c", repoGit("/w"))
    await s.fire({
      toolName: "bash",
      parentToolCallId: "p",
      input: { command: "git commit" },
      content: text("[dev 6c9688b] x"),
    })
    expect(s.calls).toHaveLength(1)
  })

  test("skips without cue or git when the session has no context", async () => {
    const s = setup(undefined, repoGit("/w"))
    await s.fire({ toolName: "bash", input: { command: "git commit" }, content: text("[dev 6c9688b] x") })
    expect(s.calls).toHaveLength(0)
    expect(s.gitCalls).toHaveLength(0)
  })

  test("quiet commit: moved HEAD records the new commit", async () => {
    const OLD = "1".repeat(40)
    const s = setup("a/b/c", { ...repoGit("/w"), "/w rev-parse --verify --quiet HEAD": OLD })
    const call = { toolName: "bash", input: { command: "git commit -q -m x" } }
    await s.start(call)
    s.git["/w rev-parse --verify --quiet HEAD"] = FULL
    s.git[`/w log -1 --format=%s ${FULL}`] = "feat: quiet"
    s.git["/w symbolic-ref --short --quiet HEAD"] = "dev"
    await s.fire({ ...call, content: text("") })
    expect(s.calls).toEqual([
      activityArgv(
        "a/b/c",
        "git_commit",
        { hash: FULL, branch: "dev", title: "feat: quiet", repo: "o/r", root: "/w" },
        "s1",
      ),
    ])
  })

  test("quiet commit: unchanged HEAD records nothing", async () => {
    const s = setup("a/b/c", { ...repoGit("/w"), "/w rev-parse --verify --quiet HEAD": FULL })
    const call = { toolName: "bash", input: { command: "git commit -q -m x" } }
    await s.start(call)
    await s.fire({ ...call, isError: true, content: text("nothing to commit") })
    expect(s.calls).toHaveLength(0)
  })

  test("quiet commit without a start snapshot records an unverified event", async () => {
    const s = setup("a/b/c", repoGit("/w"))
    await s.fire({ toolName: "bash", input: { command: "git commit -q -m x" }, content: text("") })
    expect(s.calls).toHaveLength(1)
    expect(JSON.parse(s.calls[0]![7]!)).toMatchObject({
      hash: null,
      verified: false,
      command: "git commit -q -m x",
      root: "/w",
    })
    await s.fire({ toolName: "bash", isError: true, input: { command: "git commit -q" }, content: text("") })
    expect(s.calls).toHaveLength(1)
  })

  test("no event without proof: unresolved hashes, non-commits", async () => {
    const s = setup("a/b/c", repoGit("/w"))
    await s.fire({ toolName: "bash", input: { command: "git commit" }, content: text("[dev 1111111] x") })
    await s.fire({ toolName: "bash", input: { command: "git log" }, content: text("[dev 6c9688b] x") })
    await s.fire({ toolName: "read", input: { command: "git commit" }, content: text("[dev 6c9688b] x") })
    await s.fire({ toolName: "bash", input: {}, content: text("[dev 6c9688b] x") })
    expect(s.calls).toHaveLength(0)
  })
})
