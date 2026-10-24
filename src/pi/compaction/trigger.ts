import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { contextFlag, dirFlag, storeFlag } from "../lib/cue-args"
import { liveFiles } from "./log-files"
import { cacheRoot } from "./lock"
import { logDir } from "./prepare"
import { type CompactionLimits, DEFAULT_LIMITS } from "./split"

/**
 * Starts background compaction after a successful cue-log tool call that
 * pushes the context's live log above the threshold. The pipeline runs
 * as a detached process, so the session never waits for it; every
 * failure here is a warning.
 */

export const PIPELINE = fileURLToPath(new URL("./pipeline.ts", import.meta.url))
export const PIPELINE_LOG = "pipeline.log"

export interface ContextPaths {
  store: string
  address: string
}

export type Spawner = (paths: ContextPaths, runDir: string) => void

export function runDirFor(root: string, address: string, now = new Date()): string {
  const id = `${now.toISOString().replace(/[:.]/g, "-")}-${process.pid}`
  return join(root, address, id)
}

/**
 * Spawn the pipeline detached, output to pipeline.log in the run dir.
 * Under pi, process.execPath is pi's compiled bun binary; BUN_BE_BUN
 * makes it run the .ts entrypoint as plain bun.
 */
export const spawnDetached: Spawner = (paths, runDir) => {
  mkdirSync(runDir, { recursive: true })
  const fd = openSync(join(runDir, PIPELINE_LOG), "a")
  try {
    const child = spawn(process.execPath, [PIPELINE, paths.store, paths.address, runDir], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, BUN_BE_BUN: "1" },
    })
    child.on("error", (err) => console.error(`cue: compaction not started: ${err.message}`))
    child.unref()
  } finally {
    closeSync(fd)
  }
}

/** Spawn a compaction when the live log exceeds the threshold. */
export function maybeCompact(
  paths: ContextPaths,
  spawner: Spawner = spawnDetached,
  limits: CompactionLimits = DEFAULT_LIMITS,
  root: string = cacheRoot(),
): string | null {
  if (liveFiles(logDir(paths)).length <= limits.threshold) return null
  const runDir = runDirFor(root, paths.address)
  spawner(paths, runDir)
  return runDir
}

/** Store and address the cue-log call wrote to, via `cue status --json`. */
async function resolvePaths(
  pi: ExtensionAPI,
  input: Record<string, unknown>,
  cwd: string,
): Promise<ContextPaths | null> {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined)
  const argv = ["status", "--json", ...dirFlag(str("dir"), cwd), ...storeFlag(str("store")), ...contextFlag(str("context"))]
  const r = await pi.exec("cue", argv, { cwd })
  if (r.code !== 0) throw new Error(r.stderr.trim() || `cue status exit ${r.code}`)
  const s = JSON.parse(r.stdout) as { store?: string; address?: string }
  return s.store && s.address ? { store: s.store, address: s.address } : null
}

export function registerCompactionTrigger(pi: ExtensionAPI, spawner: Spawner = spawnDetached): void {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "cue-log" || event.isError) return
    try {
      const paths = await resolvePaths(pi, event.input as Record<string, unknown>, ctx.cwd)
      if (paths) maybeCompact(paths, spawner)
    } catch (err) {
      const message = `cue: compaction not started: ${(err as Error).message ?? err}`
      if (ctx.hasUI) ctx.ui.notify(message, "warning")
      else console.error(message)
    }
  })
}
