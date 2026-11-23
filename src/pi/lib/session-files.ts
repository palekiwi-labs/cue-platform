import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import type { SessionRow } from "../browser/sessions"

/** Session files parsed at once, as pi's session list does. */
export const MAX_CONCURRENT_SESSION_LOADS = 10
/** Loaded files between published partial lists, as pi's current-folder list. */
export const SESSION_PUBLISH_INTERVAL = 10

/**
 * Progress of a session list load. `partial` holds the rows loaded so
 * far, newest first; it is present after the first file, every
 * SESSION_PUBLISH_INTERVAL files and after the last one.
 */
export type SessionRowsProgress = (loaded: number, total: number, partial?: SessionRow[]) => void

/**
 * Every `*.jsonl` file in the project directories of pi's sessions
 * directory, by file name descending: newest session first, since pi
 * names session files by creation time.
 */
export async function sessionFiles(sessionsDir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => join(sessionsDir, e.name))
  const files = await Promise.all(dirs.map(async (dir) => {
    try {
      return (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f))
    } catch {
      return []
    }
  }))
  return files.flat().sort((a, b) => basename(b).localeCompare(basename(a)))
}

const newestFirst = (rows: SessionRow[]): SessionRow[] => rows.sort((a, b) => b.modified - a.modified)

/**
 * Rows of `paths`, read MAX_CONCURRENT_SESSION_LOADS at a time in path
 * order. `keep` filters every published and the final list; files that
 * fail to read or yield no row are counted as loaded and skipped.
 */
export async function loadSessionRows(
  paths: string[],
  read: (path: string) => Promise<SessionRow | null>,
  keep: (rows: SessionRow[]) => SessionRow[] = (rows) => rows,
  onProgress?: SessionRowsProgress,
): Promise<SessionRow[]> {
  const rows: SessionRow[] = []
  let next = 0
  let loaded = 0
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const path = paths[next++]!
      const row = await read(path).catch(() => null)
      loaded++
      if (row) rows.push(row)
      const publish = loaded === 1 || loaded % SESSION_PUBLISH_INTERVAL === 0 || loaded === paths.length
      onProgress?.(loaded, paths.length, publish ? newestFirst(keep([...rows])) : undefined)
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_SESSION_LOADS, paths.length) }, worker))
  return newestFirst(keep(rows))
}
