import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { cueFailureMessage, runCue } from "./cue-exec"

function makePi(result: { stdout: string; stderr: string; code: number }) {
  const calls: { command: string; args: string[]; cwd?: string }[] = []
  const pi = {
    exec: async (command: string, args: string[], options?: { cwd?: string }) => {
      calls.push({ command, args, cwd: options?.cwd })
      return { ...result, killed: false }
    },
  } as unknown as ExtensionAPI
  return { pi, calls }
}

describe("cueFailureMessage", () => {
  test("prefers stderr, names subcommand and cwd", () => {
    expect(cueFailureMessage(["add", "--type", "spec"], "/w", 1, "Error: bad\n", "")).toBe(
      "cue add --type failed in /w: Error: bad",
    )
    expect(cueFailureMessage(["log", "add"], "/w", 1, "Error: bad\n", "")).toBe(
      "cue log add failed in /w: Error: bad",
    )
  })

  test("falls back to stdout then exit code", () => {
    expect(cueFailureMessage(["log", "add"], "/w", 2, "", "")).toBe(
      "cue log add failed in /w: exit code 2",
    )
    expect(cueFailureMessage(["log", "add"], "/w", 2, "", "partial output")).toBe(
      "cue log add failed in /w: partial output",
    )
  })
})

describe("runCue", () => {
  test("invokes cue with argv and cwd, returns trimmed stdout", async () => {
    const { pi, calls } = makePi({ stdout: "  ok  \n", stderr: "", code: 0 })
    const out = await runCue(pi, ["context", "create", "x"], "/work")
    expect(out).toBe("ok")
    expect(calls).toEqual([
      { command: "cue", args: ["context", "create", "x"], cwd: "/work" },
    ])
  })

  test("throws cue's diagnostic on non-zero exit", async () => {
    const { pi } = makePi({ stdout: "", stderr: "Error: nope\n", code: 1 })
    await expect(runCue(pi, ["add"], "/work")).rejects.toThrow(
      "cue add failed in /work: Error: nope",
    )
  })
})
