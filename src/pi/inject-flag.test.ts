import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { CUE_CONTEXT_TYPE } from "./lib/current-context"
import { INJECT_FLAG, registerInjectFlag } from "./inject-flag"

function setup(flag: string | undefined) {
  const injected: string[] = []
  const warnings: string[] = []
  const flags: string[] = []
  let start: ((e: unknown, ctx: unknown) => Promise<void>) | undefined
  const pi = {
    registerFlag: (name: string) => flags.push(name),
    getFlag: () => flag,
    on: (ev: string, h: (e: unknown, ctx: unknown) => Promise<void>) => {
      if (ev === "session_start") start = h
    },
  } as unknown as ExtensionAPI
  registerInjectFlag(pi, async (_pi, _ctx, address) => {
    injected.push(address)
  })
  const run = (branch: unknown[]) =>
    start!({}, {
      cwd: "/w",
      hasUI: true,
      ui: { notify: (m: string) => warnings.push(m) },
      sessionManager: { getSessionId: () => "s", getBranch: () => branch },
    })
  return { injected, warnings, flags, run }
}

describe("registerInjectFlag", () => {
  test("registers the flag", () => {
    expect(setup(undefined).flags).toEqual([INJECT_FLAG])
  })

  test("injects into an unlinked session", async () => {
    const s = setup("a/b/review-pr-1")
    await s.run([{ type: "message" }])
    expect(s.injected).toEqual(["a/b/review-pr-1"])
  })

  test("does nothing when the session is already linked", async () => {
    const s = setup("a/b/review-pr-1")
    await s.run([{ type: "custom", customType: CUE_CONTEXT_TYPE, data: { address: "a/b/review-pr-1" } }])
    expect(s.injected).toEqual([])
  })

  test("does nothing without the flag", async () => {
    const s = setup(undefined)
    await s.run([])
    expect(s.injected).toEqual([])
  })

  test("warns on a malformed address", async () => {
    const s = setup("slug")
    await s.run([])
    expect(s.injected).toEqual([])
    expect(s.warnings.length).toBe(1)
  })
})
