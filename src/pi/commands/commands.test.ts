import { describe, expect, test } from "bun:test"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"
import cuePlugins from "../index"
import { contextChildren } from "../lib/context-children"

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
const fail = (stderr = "Error: boom"): ExecResult => ({
  stdout: "",
  stderr,
  code: 1,
})

interface CommandRegistration {
  description?: string
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
}

/**
 * Command-oriented ExtensionAPI mock: captures registrations (with
 * options), sent user messages, and exec calls dispatched through a
 * configurable handler.
 */
function makeCommandPi(handler: ExecHandler = () => ok()) {
  const commands: Record<string, CommandRegistration> = {}
  const sent: { content: string; options?: { deliverAs?: string } }[] = []
  const execCalls: ExecCall[] = []

  const pi = {
    registerTool: () => {},
    on: () => {},
    registerShortcut: () => {},
    registerCommand: (name: string, options: CommandRegistration) => {
      commands[name] = options
    },
    sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
      sent.push({ content, options })
    },
    exec: async (command: string, args: string[], options?: { cwd?: string }) => {
      const call = { command, args, cwd: options?.cwd }
      execCalls.push(call)
      return { ...handler(call), killed: false }
    },
  } as unknown as ExtensionAPI

  return { pi, commands, sent, execCalls }
}

function cmdCtx(idle = true): ExtensionCommandContext {
  return { cwd: "/work", isIdle: () => idle } as unknown as ExtensionCommandContext
}

interface SentMessage {
  content: string
  options?: { deliverAs?: string }
}

async function runCommand(
  name: string,
  args: string,
  opts?: { idle?: boolean; handler?: ExecHandler },
): Promise<{ msg: string; execCalls: ExecCall[]; sent: SentMessage[] }> {
  const { pi, commands, sent, execCalls } = makeCommandPi(opts?.handler)
  cuePlugins(pi)
  const cmd = commands[name]
  if (!cmd) throw new Error(`command ${name} not registered`)
  await cmd.handler(args, cmdCtx(opts?.idle ?? true))
  return { msg: sent[0]?.content ?? "", execCalls, sent }
}

/**
 * Default exec handler answering the orientation gathering calls: git
 * context (feature/x on master), cue status, two child contexts, a log
 * entry, and rendered spec+plan.
 */
function orientationPi(overrides: Record<string, ExecResult> = {}): ExecHandler {
  return (call: ExecCall): ExecResult => {
    const cueKey = call.command === "cue" ? call.args.join(" ") : ""
    if (cueKey && cueKey in overrides) return overrides[cueKey]!
    if (call.command === "git") {
      switch (call.args[0]) {
        case "symbolic-ref":
          return ok("feature/x\n")
        case "config":
          return ok("master\n")
        case "merge-base":
          return ok("abc123\n")
        default:
          return fail("")
      }
    }
    const a = call.args
    if (a[0] === "status" && a.includes("--json")) {
      return ok(JSON.stringify({ address: "scope/repo/ctx" }))
    }
    if (a[0] === "status") return ok("active context: ctx")
    if (a[0] === "context" && a[1] === "list") {
      return ok("scope/repo/child-a\nscope/repo/child-b")
    }
    if (a[0] === "log") return ok("- **Milestone:** shipped")
    if (a[0] === "render") return ok("SPEC\nPLAN")
    return ok()
  }
}

describe("command registration", () => {
  test("cuePlugins registers every command name", () => {
    const { pi, commands } = makeCommandPi()
    cuePlugins(pi)
    expect(Object.keys(commands).sort()).toEqual([
      "cue:context:current",
      "cue:context:inject",
      "cue:context:pins",
      "cue:idea",
      "mcp-cast",
      "review:run",
    ])
  })
})

describe("contextChildren helper", () => {
  async function runChildren(
    handler: ExecHandler,
    slug?: string,
  ): Promise<{ block: string; execCalls: ExecCall[] }> {
    const { pi, execCalls } = makeCommandPi(handler)
    const block = await contextChildren(pi, "/work", slug)
    return { block, execCalls }
  }

  test("wraps direct children in <children> tags", async () => {
    const { block, execCalls } = await runChildren(orientationPi())
    expect(block).toBe("<children>\nscope/repo/child-a\nscope/repo/child-b\n</children>")
    const list = execCalls.find((c) => c.args[0] === "context")!
    expect(list.args).toEqual([
      "context",
      "list",
      "--scope",
      "store",
      "--filter",
      "parent=scope/repo/ctx",
    ])
  })

  test("passes the slug to cue status --json", async () => {
    const { execCalls } = await runChildren(orientationPi(), "auth")
    expect(execCalls[0].args).toEqual(["status", "--context", "auth", "--json"])
  })

  test("returns empty when status has no address (unset context)", async () => {
    const { block, execCalls } = await runChildren(
      orientationPi({ "status --json": ok("{}") }),
    )
    expect(block).toBe("")
    expect(execCalls).toHaveLength(1)
  })

  test("returns empty when cue status fails", async () => {
    const { block } = await runChildren(
      orientationPi({ "status --json": fail() }),
    )
    expect(block).toBe("")
  })

  test("returns empty when context list fails", async () => {
    const { block } = await runChildren(
      orientationPi({
        "context list --scope store --filter parent=scope/repo/ctx": fail(),
      }),
    )
    expect(block).toBe("")
  })

  test("returns empty when the list is empty", async () => {
    const { block } = await runChildren(
      orientationPi({
        "context list --scope store --filter parent=scope/repo/ctx": ok(""),
      }),
    )
    expect(block).toBe("")
  })
})

describe("/cue:idea", () => {
  test("captures the idea and loads the cue-idea skill", async () => {
    const { msg, execCalls } = await runCommand("cue:idea", "port acuity to pi", {
      handler: orientationPi(),
    })
    expect(execCalls).toHaveLength(0)
    expect(msg).toContain("<idea>\nport acuity to pi\n</idea>")
    expect(msg).toContain("PWD: /work")
    expect(msg).toContain(
      "Load the `cue-idea` skill and follow it for the idea in `<idea>`.",
    )
  })
})

describe("/review:run", () => {
  test("sends the workflow prompt with resolved arguments", async () => {
    const { msg, execCalls, sent } = await runCommand(
      "review:run",
      "--reviewers opus,glm",
      { handler: orientationPi() },
    )
    expect(execCalls).toHaveLength(0)
    expect(sent).toHaveLength(1)
    expect(msg).toContain("<arguments>\n--reviewers opus,glm\n</arguments>")
    expect(msg).toContain("PWD: /work")
    expect(msg).toContain("# Automated Code Diff Review Workflow")
    expect(msg).toContain("delegate")
    expect(msg).toContain("review-findings.json")
  })

  test("omits the arguments block when none are given", async () => {
    const { msg } = await runCommand("review:run", "", {
      handler: orientationPi(),
    })
    expect(msg).not.toContain("<arguments>")
    expect(msg).toContain("# Automated Code Diff Review Workflow")
  })
})
