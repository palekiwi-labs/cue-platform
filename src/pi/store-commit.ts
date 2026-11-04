import { realpathSync } from "node:fs"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { resolvePaths } from "./compaction/trigger"

/**
 * Snapshots the logged context after every successful cue-log call: stages
 * and commits that context's directory only, as `<context address>: <log
 * title>`. Changes elsewhere in the store are left for a manual sweep. A store
 * that is not the top of its own git repo, or has nothing to commit, is left alone. Never
 * pushes. Every failure is a warning; the next call commits what was missed.
 */
export function registerStoreCommit(pi: ExtensionAPI): void {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "cue-log" || event.isError) return
    try {
      const input = event.input as Record<string, unknown>
      const paths = await resolvePaths(pi, input, ctx.cwd)
      if (!paths) return
      const git = (...args: string[]) => pi.exec("git", ["-C", paths.store, ...args], { cwd: ctx.cwd })
      const top = await git("rev-parse", "--show-toplevel")
      if (top.code !== 0 || top.stdout.trim() !== realpathSync(paths.store)) return
      const dirty = await git("status", "--porcelain", "--", paths.address)
      if (dirty.code !== 0) throw new Error(dirty.stderr.trim() || `git status exit ${dirty.code}`)
      if (dirty.stdout.trim() === "") return
      const title = typeof input.title === "string" ? input.title.split("\n")[0].trim() : ""
      for (const args of [
        ["add", "-A", "--", paths.address],
        ["commit", "-m", `${paths.address}: ${title}`, "--", paths.address],
      ]) {
        const r = await git(...args)
        if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} exit ${r.code}`)
      }
    } catch (err) {
      const message = `cue: store not committed: ${(err as Error).message ?? err}`
      if (ctx.hasUI) ctx.ui.notify(message, "warning")
      else console.error(message)
    }
  })
}
