import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

/** Root of the cue store, as cue itself resolves it; cached. */
let cachedStoreRoot: string | undefined
export function storeRoot(cwd: string): string {
  if (cachedStoreRoot) return cachedStoreRoot
  const r = spawnSync("cue", ["status", "--json"], { cwd, encoding: "utf8" })
  try {
    const store = JSON.parse(r.stdout ?? "{}").store
    if (typeof store === "string" && store !== "") cachedStoreRoot = store
  } catch {
    // fall through to the default
  }
  cachedStoreRoot ??= process.env.CUE_STORE || join(homedir(), ".cue")
  return cachedStoreRoot
}
