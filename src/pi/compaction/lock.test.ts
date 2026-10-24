import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireLock, lockPath, STALE_MS } from "./lock"

const root = mkdtempSync(join(tmpdir(), "compaction-lock-"))
const path = lockPath(root, "org/repo/ctx")

afterEach(() => rmSync(path, { force: true }))

test("excludes a second holder until released", () => {
  const release = acquireLock(path)!
  expect(release).toBeFunction()
  expect(acquireLock(path)).toBeNull()
  release()
  expect(acquireLock(path)).toBeFunction()
})

test("breaks a lock whose holder is dead", () => {
  writeFileSync(path, "999999999")
  expect(acquireLock(path)).toBeFunction()
})

test("breaks a lock older than the stale timeout", () => {
  writeFileSync(path, String(process.pid))
  const old = (Date.now() - STALE_MS - 1000) / 1000
  utimesSync(path, old, old)
  expect(acquireLock(path)).toBeFunction()
})
