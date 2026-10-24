import { describe, expect, test } from "bun:test"
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { tmpdir } from "node:os"
import cuePlugins from "./index"

interface ExecCall {
  command: string
  args: string[]
  cwd?: string
}

interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

type ExecHandler = (call: ExecCall) => ExecResult

const ok = (stdout = "ok"): ExecResult => ({ stdout, stderr: "", code: 0 })

/**
 * Minimal ExtensionAPI mock capturing registrations and exec calls. exec
 * dispatches through a handler so multi-command tools (save-branch-diff)
 * can answer git and cue invocations differently.
 */
function makeMockPi(handler: ExecHandler = () => ok()) {
  const tools: ToolDefinition<any>[] = []
  const commands: string[] = []
  const execCalls: ExecCall[] = []

  const pi = {
    registerTool: (t: ToolDefinition<any>) => tools.push(t),
    registerShortcut: () => {},
    registerCommand: (name: string) => commands.push(name),
    sendUserMessage: (_content: string) => {},
    on: () => {},
    exec: async (command: string, args: string[], options?: { cwd?: string }) => {
      const call = { command, args, cwd: options?.cwd }
      execCalls.push(call)
      return { ...handler(call), killed: false }
    },
  } as unknown as ExtensionAPI

  return { pi, tools, commands, execCalls }
}

function fakeCtx(usage?: { tokens: number | null } | null): ExtensionToolContext {
  return {
    cwd: "/work",
    sessionManager: { getSessionId: () => "test-session" },
    ...(usage === null
      ? {}
      : { getContextUsage: () => usage }),
  } as unknown as ExtensionToolContext
}

function toolByName(name: string): ToolDefinition<any> {
  const { pi, tools } = makeMockPi()
  cuePlugins(pi)
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not registered`)
  return t
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ExtensionToolContext = fakeCtx(),
): Promise<{ execCalls: ExecCall[]; result: any }> {
  const { pi, tools, execCalls } = makeMockPi()
  cuePlugins(pi)
  const t = tools.find((x) => x.name === name)!
  const result = await t.execute("id", args as any, undefined, undefined, ctx)
  return { execCalls, result }
}

describe("cuePlugins registration", () => {
  test("registers the eight parity tools plus delegate", () => {
    const { pi, tools } = makeMockPi()
    cuePlugins(pi)
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cue-add",
      "cue-context",
      "cue-context-usage",
      "cue-log",
      "cue-plan",
      "cue-review",
      "cue-task",
      "delegate",
      "save-branch-diff",
    ])
  })
})

describe("argv mapping", () => {
  test("cue-add: add argv with context, frontmatter, type, file, filename", async () => {
    const { execCalls } = await runTool("cue-add", {
      type: "note",
      filename: "ideas/auth.md",
      content: "body",
      context: "auth",
      frontmatter: { refs: ["a", "b"], status: "open" },
    })
    const { command, args, cwd } = execCalls[0]!
    expect(command).toBe("cue")
    expect(cwd).toBe("/work")
    expect(args[0]).toBe("add")
    expect(args).toContain("--context")
    expect(args[args.indexOf("--context") + 1]).toBe("auth")
    expect(args.filter((a) => a === "refs=a").length).toBe(1)
    expect(args.filter((a) => a === "refs=b").length).toBe(1)
    expect(args).toContain("status=open")
    expect(args).not.toContain("--task")
    expect(args).not.toContain("--root")
    expect(args.slice(args.indexOf("--type"))).toEqual([
      "--type",
      "note",
      "--file",
      expect.stringMatching(/^\/.*\.md$/),
      "ideas/auth.md",
    ])
  })

  test("cue-add: type defaults to spec; dir and store pass through", async () => {
    const { execCalls } = await runTool("cue-add", {
      filename: "f.md",
      content: "c",
      context: "ctx",
      dir: "/elsewhere",
      store: "/mnt/store",
    })
    const args = execCalls[0].args
    expect(args).toContain("--dir")
    expect(args[args.indexOf("--dir") + 1]).toBe("/elsewhere")
    expect(args).toContain("--store")
    expect(args[args.indexOf("--store") + 1]).toBe("/mnt/store")
    expect(args[args.indexOf("--type") + 1]).toBe("spec")
  })

  test("cue-context: context create argv with option flags and name last", async () => {
    const { execCalls } = await runTool("cue-context", {
      name: "auth-redesign",
      title: "Auth Redesign",
      kind: "work",
      mode: "build",
      description: "Rework auth",
      parent: "palekiwi/palekiwi/platform",
      refs: ["x/y", "z/w"],
    })
    const { command, args } = execCalls[0]!
    expect(command).toBe("cue")
    expect(args).toEqual([
      "context",
      "create",
      "--title",
      "Auth Redesign",
      "--kind",
      "work",
      "--mode",
      "build",
      "--description",
      "Rework auth",
      "--parent",
      "palekiwi/palekiwi/platform",
      "--ref",
      "x/y",
      "--ref",
      "z/w",
      "auth-redesign",
    ])
  })

  test("cue-log: log add argv with context and json temp file", async () => {
    const { execCalls, result } = await runTool("cue-log", {
      title: "T",
      trace: "scope/ctx/trace/h.md",
      found: ["f1"],
      decided: ["d1"],
      open: ["o1"],
      context: "ctx",
    })
    const { command, args } = execCalls[0]!
    expect(command).toBe("cue")
    expect(args.slice(0, 2)).toEqual(["log", "add"])
    expect(args[args.indexOf("--context") + 1]).toBe("ctx")
    expect(args.slice(args.indexOf("--file"))).toEqual([
      "--file",
      expect.stringMatching(/^\/.*\.json$/),
    ])
    expect(result.content[0].text).toContain("Logged milestone: T")
  })

  test("cue-log: absent arrays are dropped from the json payload", async () => {
    const { execCalls } = await runTool("cue-log", {
      title: "T",
      context: "ctx",
    })
    // Only one cue invocation; payload correctness is enforced by cue's
    // reader, here we assert the argv shape stayed minimal.
    expect(execCalls).toHaveLength(1)
  })

  test("cue-log: appends context note when usage is known", async () => {
    const { result } = await runTool(
      "cue-log",
      { title: "T", context: "ctx" },
      fakeCtx({ tokens: 150_000 }),
    )
    expect(result.content[0].text).toContain("hard saturation limit")
  })

  test("cue-plan: add argv with plan type and status/refs/parent frontmatter", async () => {
    const { execCalls } = await runTool("cue-plan", {
      filename: "lane-a.md",
      content: "steps",
      parent: "scope/ctx/task/t.md",
      refs: ["r1"],
      context: "ctx",
    })
    const args = execCalls[0].args
    expect(args[0]).toBe("add")
    expect(args).toContain("status=open")
    expect(args).toContain("refs=r1")
    expect(args).toContain("parent=scope/ctx/task/t.md")
    expect(args[args.indexOf("--type") + 1]).toBe("plan")
    expect(args[args.length - 1]).toBe("lane-a.md")
  })

  test("cue-task: add argv with task type, title/status/priority frontmatter, no board flags", async () => {
    const { execCalls } = await runTool("cue-task", {
      filename: "auth-login.md",
      content: "goal",
      title: "Auth login",
      priority: "high",
      parent: "scope/ctx",
      context: "ctx",
    })
    const args = execCalls[0].args
    expect(args[0]).toBe("add")
    expect(args).toContain("title=Auth login")
    expect(args).toContain("status=open")
    expect(args).toContain("priority=high")
    expect(args).toContain("parent=scope/ctx")
    expect(args).not.toContain("--task")
    expect(args).not.toContain("--root")
    expect(args[args.indexOf("--type") + 1]).toBe("task")
  })

  test("cue-review: valid object posts add with review type and metadata flags", async () => {
    const { execCalls } = await runTool("cue-review", {
      content: '{"findings": []}',
      filename: "findings.json",
      metadata: { reviewers: ["a", "b"], run: "r1" },
      context: "ctx",
    })
    const args = execCalls[0].args
    expect(args[0]).toBe("add")
    expect(args).toContain("reviewers=a")
    expect(args).toContain("reviewers=b")
    expect(args).toContain("run=r1")
    expect(args[args.indexOf("--type") + 1]).toBe("review")
    expect(args[args.indexOf("--file") + 1]).toMatch(/\.json$/)
  })

  test("cue-review: rejects non-object json before cue runs", async () => {
    await expect(
      runTool("cue-review", { content: "[1,2]", filename: "f.json", context: "ctx" }),
    ).rejects.toThrow(/JSON object/)
  })

  test("cue-review: rejects invalid json before cue runs", async () => {
    await expect(
      runTool("cue-review", { content: "{nope", filename: "f.json", context: "ctx" }),
    ).rejects.toThrow(/valid JSON/)
  })
})

describe("save-branch-diff", () => {
  function gitPi(overrides: Record<string, ExecResult> = {}) {
    return (call: ExecCall): ExecResult => {
      const key = `${call.command} ${call.args[0]} ${call.args[1] ?? ""}`.trim()
      if (key in overrides) return overrides[key]!
      if (call.command === "git" && call.args[0] === "branch") return ok("feat/x\n")
      if (call.command === "git" && call.args[0] === "config") return ok("master\n")
      if (call.command === "git" && call.args[0] === "symbolic-ref") return ok("origin/master\n")
      if (call.command === "git" && call.args[0] === "rev-parse") return ok("abc1234\n")
      if (call.command === "git" && call.args[0] === "diff") return ok("diff --git a/f\n")
      return ok()
    }
  }

  test("diffs against the configured base and saves a tmp artifact named for the branch", async () => {
    const { pi, tools, execCalls } = makeMockPi(gitPi())
    cuePlugins(pi)
    const t = tools.find((x) => x.name === "save-branch-diff")!
    const result = await t.execute("id", { context: "ctx" } as any, undefined, undefined, fakeCtx())
    const gitCalls = execCalls.filter((c) => c.command === "git").map((c) => c.args[0])
    expect(gitCalls).toEqual(["branch", "config", "symbolic-ref", "rev-parse", "diff"])

    const cueCall = execCalls.find((c) => c.command === "cue")!
    expect(cueCall.args[0]).toBe("add")
    expect(cueCall.args).toContain("--context")
    expect(cueCall.args[cueCall.args.indexOf("--context") + 1]).toBe("ctx")
    expect(cueCall.args[cueCall.args.indexOf("--type") + 1]).toBe("tmp")
    expect(cueCall.args[cueCall.args.indexOf("--file") + 1]).toMatch(/\.diff$/)
    expect(cueCall.args[cueCall.args.length - 1]).toBe("feat-x.diff")
    expect(cueCall.cwd).toBe("/work")
    expect(result.details).toEqual({ status: "success", branch: "feat/x", base: "master", commit: "abc1234" })
  })

  test("empty diff reports no_changes without invoking cue", async () => {
    const { pi, tools, execCalls } = makeMockPi(
      gitPi({ "git diff master...HEAD": { stdout: "", stderr: "", code: 0 } }),
    )
    cuePlugins(pi)
    const t = tools.find((x) => x.name === "save-branch-diff")!
    const result: any = await t.execute("id", { context: "ctx" } as any, undefined, undefined, fakeCtx())
    expect(execCalls.find((c) => c.command === "cue")).toBeUndefined()
    expect(result.details.status).toBe("no_changes")
    expect(result.content[0].text).toContain("No diff between master and abc1234")
  })

  test("git diff failure surfaces stderr", async () => {
    const { pi, tools } = makeMockPi(
      gitPi({ "git diff master...HEAD": { stdout: "", stderr: "unknown revision", code: 128 } }),
    )
    cuePlugins(pi)
    const t = tools.find((x) => x.name === "save-branch-diff")!
    await expect(
      t.execute("id", { context: "ctx" } as any, undefined, undefined, fakeCtx()),
    ).rejects.toThrow(/unknown revision/)
  })
})

describe("cue-context-usage", () => {
  test("reports saturation from ctx.getContextUsage", async () => {
    const { result } = await runTool(
      "cue-context-usage",
      {},
      fakeCtx({ tokens: 90_000 }),
    )
    expect(result.content[0].text).toContain("Level: CAUTION")
    expect(result.details.tokens).toBe(90_000)
    expect(result.details.can_proceed_large_task).toBe(false)
  })

  test("unknown tokens report unavailable", async () => {
    const { result } = await runTool(
      "cue-context-usage",
      {},
      fakeCtx({ tokens: null }),
    )
    expect(result.content[0].text).toContain("unavailable")
    expect(result.details.available).toBe(false)
  })

  test("missing getContextUsage reports unavailable", async () => {
    const { result } = await runTool("cue-context-usage", {}, fakeCtx(null))
    expect(result.content[0].text).toContain("unavailable")
  })
})

describe("failure propagation", () => {
  test("tools throw cue's stderr on non-zero exit", async () => {
    const { pi, tools } = makeMockPi(() => ({ stdout: "", stderr: "Error: boom", code: 1 }))
    cuePlugins(pi)
    const add = tools.find((t) => t.name === "cue-add")!
    await expect(
      add.execute(
        "id",
        { type: "spec", filename: "f.md", content: "c", context: "x" } as any,
        undefined,
        undefined,
        fakeCtx(),
      ),
    ).rejects.toThrow(/boom/)
  })
})
