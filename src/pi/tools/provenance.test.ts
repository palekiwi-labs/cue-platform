import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { cueAddTool } from "./cue-add"
import { cuePlanTool } from "./cue-plan"
import { cueReviewTool } from "./cue-review"
import { cueTaskTool } from "./cue-task"
import { saveBranchDiffTool } from "./save-branch-diff"

/**
 * Every artifact-creating tool passes pi provenance to `cue add`, so
 * cue's native artifact_created event names the session that wrote it.
 */

function fakePi() {
  const cueCalls: string[][] = []
  const pi = {
    exec: async (cmd: string, args: string[]) => {
      if (cmd === "cue") cueCalls.push(args)
      const stdout =
        cmd === "git" && args[0] === "diff"
          ? "diff --git a/x b/x\n"
          : cmd === "git" && args[0] === "branch"
            ? "feat"
            : cmd === "git" && args[0] === "rev-parse"
              ? "abc"
              : cmd === "cue"
                ? "a/b/c/x"
                : ""
      return { stdout, stderr: "", code: 0, killed: false }
    },
  } as unknown as ExtensionAPI
  return { pi, cueCalls }
}

const ctx = {
  cwd: "/w",
  sessionManager: { getSessionId: () => "sess-9" },
} as never

const base = { filename: "x.md", content: "body", context: "c" }

const cases: [string, (pi: ExtensionAPI) => { execute: Function }, object][] = [
  ["cue-add", cueAddTool, base],
  ["cue-plan", cuePlanTool, base],
  ["cue-task", cueTaskTool, { ...base, title: "T" }],
  ["cue-review", cueReviewTool, { ...base, filename: "r.json", content: "{}" }],
  ["save-branch-diff", saveBranchDiffTool, { context: "c" }],
]

describe("artifact tools pass provenance to cue add", () => {
  for (const [name, factory, args] of cases) {
    test(name, async () => {
      const f = fakePi()
      await factory(f.pi).execute("id", args, undefined, undefined, ctx)
      const add = f.cueCalls.find((a) => a[0] === "add")
      expect(add).toBeDefined()
      const i = add!.indexOf("--harness")
      expect(add!.slice(i, i + 4)).toEqual([
        "--harness",
        "pi",
        "--session-id",
        "sess-9",
      ])
    })
  }
})
