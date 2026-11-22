import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Root of the cue store: `$CUE_STORE`, else `~/cue`. */
export function cueStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CUE_STORE || join(homedir(), "cue")
}

/** The `mode:` field from the frontmatter of a `context.md`, or undefined. */
export function parseContextMode(text: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return undefined
  for (const line of m[1]!.split(/\r?\n/)) {
    const f = /^mode:\s*(.*?)\s*$/.exec(line)
    if (!f) continue
    const v = f[1]!.replace(/^(['"])(.*)\1$/, "$2")
    return v === "" ? undefined : v
  }
  return undefined
}

const cache = new Map<string, { mtimeMs: number; mode: string | undefined }>()

/** The `mode:` of the context at `address`; re-read only when its context.md changes. */
export function contextMode(address: string, root: string = cueStoreRoot()): string | undefined {
  const path = join(root, address, "context.md")
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    cache.delete(path)
    return undefined
  }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.mode
  let mode: string | undefined
  try {
    mode = parseContextMode(readFileSync(path, "utf8"))
  } catch {
    mode = undefined
  }
  cache.set(path, { mtimeMs, mode })
  return mode
}
