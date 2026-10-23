import { describe, expect, test } from "bun:test"
import { diffFilename, resolveBase, sanitizeBranchName } from "./branch-diff-helpers"

describe("sanitizeBranchName", () => {
  test("slashes collapse to a single dash", () => {
    expect(sanitizeBranchName("feat/pi-extension")).toBe("feat-pi-extension")
  })

  test("unsafe runs collapse; edges stripped", () => {
    expect(sanitizeBranchName("-feat /wip!-")).toBe("feat-wip")
  })

  test("already-safe names pass through", () => {
    expect(sanitizeBranchName("release_0.2.0")).toBe("release_0.2.0")
  })
})

describe("diffFilename", () => {
  test("derives .diff filename from branch", () => {
    expect(diffFilename("feat/pi-extension")).toBe("feat-pi-extension.diff")
  })

  test("detached HEAD falls back to branch", () => {
    expect(diffFilename("")).toBe("branch.diff")
  })
})

describe("resolveBase", () => {
  test("config base wins", () => {
    expect(resolveBase("develop", "origin/master")).toBe("develop")
  })

  test("origin/HEAD is unwrapped", () => {
    expect(resolveBase("", "origin/main")).toBe("main")
  })

  test("falls back to master", () => {
    expect(resolveBase(undefined, undefined)).toBe("master")
    expect(resolveBase("  ", "not-origin-ref")).toBe("master")
  })
})
