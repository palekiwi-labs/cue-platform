import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  RECALL_COMMAND,
  RECALL_TIMEOUT_MS,
  cueRecallTool,
  recallArgv,
  recallFailureMessage,
} from "./cue-recall"

interface Call {
  command: string
  args: string[]
  options?: { cwd?: string; timeout?: number; signal?: AbortSignal }
}

function fakePi(result: { stdout?: string; stderr?: string; code?: number; killed?: boolean }) {
  const calls: Call[] = []
  const pi = {
    exec: async (command: string, args: string[], options?: Call["options"]) => {
      calls.push({ command, args, options })
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        code: result.code ?? 0,
        killed: result.killed ?? false,
      }
    },
  } as unknown as ExtensionAPI
  return { pi, calls }
}

const ctx = { cwd: "/work/repo" } as never

const report = {
  query: "jev gate",
  terms: [],
  scope: null,
  contexts: 259,
  counts: { strong: 1, likely: 0, weak: 0 },
  thresholds: { strong: 0.8, likely: 0.65, weak: 0.3 },
  results: [{ address: "a/b/jev-integration", bucket: "strong", probability: 0.9 }],
  text: "recall: 'jev gate' over 259 contexts\n1 strong.",
  diagnostics: { model: "jev-1.14.0", input_tokens: 21000 },
}

describe("recallArgv", () => {
  test("query, json format and default limit", () => {
    expect(recallArgv({ query: "q" })).toEqual([
      "--query",
      "q",
      "--format",
      "json",
      "--limit",
      "8",
    ])
  })

  test("terms and roots are comma-joined, blanks dropped", () => {
    const argv = recallArgv({
      query: "q",
      terms: ["jev", " ", "guard "],
      roots: ["a/b/c"],
      limit: 3,
    })
    expect(argv[argv.indexOf("--limit") + 1]).toBe("3")
    expect(argv[argv.indexOf("--terms") + 1]).toBe("jev,guard")
    expect(argv[argv.indexOf("--roots") + 1]).toBe("a/b/c")
  })

  test("never passes a scope", () => {
    expect(recallArgv({ query: "q", terms: ["x"], roots: ["a/b/c"] })).not.toContain(
      "--scope",
    )
  })
})

describe("cue-recall tool", () => {
  test("runs cue-recall in the session cwd with a timeout", async () => {
    const { pi, calls } = fakePi({ stdout: JSON.stringify(report) })
    await cueRecallTool(pi).execute("id", { query: "jev gate" }, undefined, undefined, ctx)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toBe(RECALL_COMMAND)
    expect(calls[0]!.options?.cwd).toBe("/work/repo")
    expect(calls[0]!.options?.timeout).toBe(RECALL_TIMEOUT_MS)
  })

  test("text goes to content, the rest of the report to details", async () => {
    const { pi } = fakePi({ stdout: JSON.stringify(report) })
    const out = await cueRecallTool(pi).execute(
      "id",
      { query: "jev gate" },
      undefined,
      undefined,
      ctx,
    )
    expect(out.content).toEqual([{ type: "text", text: report.text }])
    const details = out.details as Record<string, unknown>
    expect(details.text).toBeUndefined()
    expect(details.results).toEqual(report.results)
    expect(details.diagnostics).toEqual(report.diagnostics)
  })

  test("a failed run surfaces cue-recall's own message", async () => {
    const stderr =
      "cue-recall: TYPESAFE_API_KEY is not set; shallow recall ranks candidates with jev"
    const { pi } = fakePi({ code: 1, stderr })
    await expect(
      cueRecallTool(pi).execute("id", { query: "q" }, undefined, undefined, ctx),
    ).rejects.toThrow(`cue-recall failed in /work/repo: ${stderr}`)
  })

  test("invalid JSON is reported as such", async () => {
    const { pi } = fakePi({ stdout: "not json" })
    await expect(
      cueRecallTool(pi).execute("id", { query: "q" }, undefined, undefined, ctx),
    ).rejects.toThrow("cue-recall returned invalid JSON")
  })
})

describe("recallFailureMessage", () => {
  test("silent failure hints at PATH", () => {
    expect(recallFailureMessage("/w", 1, "", "", false)).toContain("on PATH")
  })

  test("killed run is a timeout or cancellation", () => {
    expect(recallFailureMessage("/w", 0, "", "", true)).toContain("timed out")
  })
})
