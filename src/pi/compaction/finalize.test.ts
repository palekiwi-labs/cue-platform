import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { APPLYING_MARKER, finalize, recover, uncompact } from "./finalize"
import { liveFiles, PENDING_SUFFIX, readLive } from "./log-files"
import { prepare } from "./prepare"
import type { Proposal } from "./proposal"
import { computeSplit, DEFAULT_LIMITS } from "./split"

const ADDRESS = "org/repo/ctx"
// Above Number.MAX_SAFE_INTEGER, like real nanosecond stamps.
const BASE = 1792814113359612000n

let store: string
let dir: string
let runDir: string

function stamp(i: number): string {
  return (BASE + BigInt(i)).toString()
}

function file(i: number): string {
  return stamp(i).padStart(20, "0") + ".json"
}

function writeEntry(i: number): void {
  writeFileSync(
    join(dir, file(i)),
    `{"timestamp":${stamp(i)},"title":"entry ${i}","trace":null,"found":["f${i}"],"decided":[],"open":[]}`,
  )
}

function snapshotOf(): Map<string, string> {
  return new Map(readLive(dir).map((e) => [e.file, e.sha256]))
}

function summary(covers: string[], title = "Phase") {
  return { covers, title, found: [], decided: ["d"], open: [], trace: null }
}

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), "compaction-"))
  dir = join(store, ADDRESS, "log")
  runDir = join(store, "run")
  mkdirSync(dir, { recursive: true })
  for (let i = 1; i <= 16; i++) writeEntry(i)
})

afterEach(() => rmSync(store, { recursive: true, force: true }))

const paths = () => ({ store, address: ADDRESS, runDir })

function headProposal(): Proposal {
  const head = Array.from({ length: 11 }, (_, i) => file(i + 1))
  return { summaries: [summary(head.slice(0, 6), "Early"), summary(head.slice(6))] }
}

describe("computeSplit", () => {
  test("skips logs at or below the threshold", () => {
    unlinkSync(join(dir, file(16)))
    expect(computeSplit(readLive(dir), DEFAULT_LIMITS)).toBeNull()
  })

  test("keeps the tail and carries summaries until the cap", () => {
    const live = readLive(dir)
    live[0]!.entry.compacted = { from: "1", to: "2", count: 2, archive: "a" }
    const split = computeSplit(live, DEFAULT_LIMITS)!
    expect(split.tail).toEqual([file(12), file(13), file(14), file(15), file(16)])
    expect(split.carried).toEqual([file(1)])
    expect(split.merge).toEqual([])
    expect(split.head[0]).toBe(file(2))
    for (const i of [0, 1, 2]) live[i]!.entry.compacted = { from: "1", to: "2", count: 2, archive: "a" }
    const capped = computeSplit(live, DEFAULT_LIMITS)!
    expect(capped.merge).toEqual([file(1), file(2)])
    expect(capped.carried).toEqual([file(3)])
    expect(capped.head.slice(0, 3)).toEqual([file(1), file(2), file(4)])
  })
})

describe("finalize", () => {
  test("applies summaries, archives originals, keeps raw stamps", () => {
    const bundle = prepare(paths(), DEFAULT_LIMITS)!
    expect(bundle.split.head.length).toBe(11)
    const result = finalize(paths(), bundle, headProposal())
    expect(result.ok).toBe(true)
    expect(liveFiles(dir)).toEqual([file(6), file(11), file(12), file(13), file(14), file(15), file(16)])
    const text = readFileSync(join(dir, file(6)), "utf8")
    expect(text).toContain(`"timestamp": ${stamp(6)},`)
    const entry = JSON.parse(text)
    expect(entry.compacted.from).toBe(stamp(1))
    expect(entry.compacted.count).toBe(6)
    const archiveDir = join(store, entry.compacted.archive)
    expect(readdirSync(archiveDir).sort()).toEqual([...Array.from({ length: 6 }, (_, i) => file(i + 1)), "manifest.json"].sort())
  })

  test("aborts without changes when the snapshot drifted", () => {
    const bundle = prepare(paths(), DEFAULT_LIMITS)!
    writeFileSync(join(dir, file(3)), readFileSync(join(dir, file(3)), "utf8").replace("entry 3", "edited"))
    const before = snapshotOf()
    const result = finalize(paths(), bundle, headProposal())
    expect(result).toEqual({ ok: false, reason: `snapshot changed: ${file(3)}` })
    expect(snapshotOf()).toEqual(before)
    expect(existsSync(join(dir, ".archive"))).toBe(false)
  })

  test("new entries written meanwhile are untouched", () => {
    const bundle = prepare(paths(), DEFAULT_LIMITS)!
    writeEntry(17)
    expect(finalize(paths(), bundle, headProposal()).ok).toBe(true)
    expect(liveFiles(dir)).toContain(file(17))
  })

  test("uncompact restores the original bytes", () => {
    const before = snapshotOf()
    const bundle = prepare(paths(), DEFAULT_LIMITS)!
    finalize(paths(), bundle, headProposal())
    uncompact(paths(), file(11))
    uncompact(paths(), file(6))
    expect(snapshotOf()).toEqual(before)
    expect(readdirSync(join(dir, ".archive"))).toEqual([])
  })

  test("merges summaries from archived originals", () => {
    let bundle = prepare(paths(), DEFAULT_LIMITS)!
    finalize(paths(), bundle, {
      summaries: [summary([file(1), file(2), file(3)]), summary(Array.from({ length: 8 }, (_, i) => file(i + 4)))],
    })
    for (let i = 17; i <= 27; i++) writeEntry(i)
    bundle = prepare(paths(), DEFAULT_LIMITS)!
    // Summaries at 3 and 11, so no merge yet; the head is 12..22.
    expect(bundle.split.carried).toEqual([file(3), file(11)])
    finalize(paths(), bundle, { summaries: [summary(bundle.split.head)] })
    for (let i = 28; i <= 37; i++) writeEntry(i)
    bundle = prepare(paths(), DEFAULT_LIMITS)!
    expect(bundle.split.merge).toEqual([file(3), file(11)])
    expect(bundle.mergeOriginals[file(3)]!.map((e) => e.title)).toEqual(["entry 1", "entry 2", "entry 3"])
    const raw = bundle.split.head.slice(2)
    const result = finalize(paths(), bundle, { summaries: [summary([file(3), file(11)]), summary(raw)] })
    expect(result.ok).toBe(true)
    const merged = JSON.parse(readFileSync(join(dir, file(11)), "utf8"))
    expect(merged.compacted.from).toBe(stamp(1))
    expect(merged.compacted.count).toBe(11)
  })
})

describe("recover", () => {
  function halfApply(withPending: boolean): string {
    const bundle = prepare(paths(), DEFAULT_LIMITS)!
    finalize(paths(), bundle, headProposal())
    // Re-create the state of a crash inside the first summary.
    const live = JSON.parse(readFileSync(join(dir, file(6)), "utf8"))
    const archiveDir = join(store, live.compacted.archive)
    uncompact(paths(), file(6))
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(join(archiveDir, APPLYING_MARKER), "")
    writeFileSync(
      join(archiveDir, "manifest.json"),
      JSON.stringify({ summary: file(6), entries: [1, 2, 3, 4, 5, 6].map((i) => ({ file: file(i) })) }),
    )
    if (withPending) {
      writeFileSync(join(dir, file(6) + PENDING_SUFFIX), JSON.stringify(live))
      unlinkSync(join(dir, file(1)))
    }
    return archiveDir
  }

  test("rolls forward when the summary is pending", () => {
    const archiveDir = halfApply(true)
    expect(recover(paths())[0]).toStartWith("completed")
    expect(liveFiles(dir)[0]).toBe(file(6))
    expect(existsSync(join(archiveDir, APPLYING_MARKER))).toBe(false)
  })

  test("rolls back when no summary was written", () => {
    const archiveDir = halfApply(false)
    expect(recover(paths())[0]).toStartWith("rolled back")
    expect(existsSync(archiveDir)).toBe(false)
    expect(liveFiles(dir)[0]).toBe(file(1))
  })
})
