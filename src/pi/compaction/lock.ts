import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Host-local, per-context compaction lock. It lives in the host cache,
 * never in the synced store, so it only excludes runs on this host;
 * overlap across hosts is accepted (see the spec).
 */

/** Longer than the cue-agent timeout (900 s) plus prepare/finalize. */
export const STALE_MS = 20 * 60_000

export function cacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim()
  return join(xdg ? xdg : join(homedir(), ".cache"), "cue", "compaction")
}

export function lockPath(root: string, address: string): string {
  return join(root, "locks", `${address.replaceAll("/", "__")}.lock`)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

function isStale(path: string, now: number): boolean {
  try {
    if (now - statSync(path).mtimeMs > STALE_MS) return true
    const pid = Number(readFileSync(path, "utf8").trim())
    return Number.isInteger(pid) && pid > 0 && !pidAlive(pid)
  } catch {
    return true
  }
}

/** Take the lock; returns a release function, or null when held. */
export function acquireLock(path: string, now = Date.now()): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" })
      return () => rmSync(path, { force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      if (attempt > 0 || !isStale(path, now)) return null
      rmSync(path, { force: true })
    }
  }
  return null
}
