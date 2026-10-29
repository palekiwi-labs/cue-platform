import { describe, expect, test } from "bun:test"
import type { Pr } from "./model"
import { fetchDetail, parseDetail, type PrDetail, PreviewCache } from "./preview"

const pr = { repo: "o/r", number: 7, title: "Preview", author: "author", headRef: "topic", baseRef: "main" } as Pr
const comment = (id: number, body: string, at = "2026-01-01T00:00:00Z") => ({
  id, body, user: { login: "reviewer" }, created_at: at, html_url: `https://github.com/o/r/pull/7#${id}`,
})
const json = JSON.stringify
const empty = json([[]])
const detail: PrDetail = { threads: [] }
const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe("PR details", () => {
  test("groups inline replies across pages, sorts activity newest first and messages chronologically", () => {
    const root = { ...comment(1, "Root"), path: "src/file.ts", original_line: 12, diff_hunk: "@@ -1 +1 @@\n+foo" }
    const reply = { ...comment(3, "Reply", "2026-01-04T00:00:00Z"), path: root.path, in_reply_to_id: 1 }
    const earlierReply = { ...reply, id: 5, body: "Earlier reply", created_at: "2026-01-01T12:00:00Z" }
    const otherRoot = { ...root, id: 6, body: "Other thread", created_at: "2026-01-01T18:00:00Z" }
    const parsed = parseDetail(json([[reply, otherRoot], [root, earlierReply]]), json([[
      { ...comment(2, "Review body"), submitted_at: "2026-01-03T00:00:00Z", state: "CHANGES_REQUESTED" },
      { ...comment(9, "Pending"), submitted_at: null },
      { ...comment(10, " "), submitted_at: "2026-01-05T00:00:00Z" },
    ]]), json([[{ ...comment(4, "General", "2026-01-02T00:00:00Z"), user: null }]]))
    expect(parsed.threads.map((t) => [t.kind, t.messages.map((m) => m.id)])).toEqual([
      ["inline", [1, 5, 3]], ["review", [2]], ["comment", [4]], ["inline", [6]],
    ])
    expect(parsed.threads[0]).toMatchObject({ path: "src/file.ts", line: 12 })
    expect(parsed.threads[2]!.messages[0]!.author).toBe("ghost")
    expect(parsed.threads.flatMap((t) => t.messages).filter((m) => m.body === "Root")).toHaveLength(1)
    expect(json(parsed)).not.toMatch(/html_url|diff_hunk|CHANGES_REQUESTED|threadBody/)
  })

  test("handles missing roots and empty collections; rejects bad pagination data", () => {
    expect(parseDetail(empty, empty, empty)).toEqual({ threads: [] })
    const replies = [2, 3].map((id) => ({ ...comment(id, `reply ${id}`), in_reply_to_id: 99, path: "file.ts" }))
    const result = parseDetail(json([replies]), empty, empty)
    expect(result.threads).toHaveLength(1)
    expect(result.threads[0]!.messages.map((m) => m.id)).toEqual([2, 3])
    expect(result.threads[0]!.path).toBe("file.ts")
    expect(() => parseDetail("{}", empty, empty)).toThrow("paginated arrays")
    expect(() => parseDetail("not json", empty, empty)).toThrow()
  })

  test("uses creation/submission times, ignores edits, and breaks activity ties deterministically", () => {
    const parsed = parseDetail(empty, empty, json([[
      { ...comment(1, "Old edited"), updated_at: "2026-01-09T00:00:00Z" },
      comment(2, "New", "2026-01-02T00:00:00Z"), comment(3, "Same time", "2026-01-02T00:00:00Z"),
    ]]))
    expect(parsed.threads.map((t) => t.messages[0]!.id)).toEqual([3, 2, 1])
  })

  test("fetch explicitly paginates all three collections in the selected repo", async () => {
    const calls: string[][] = []
    const result = await fetchDetail(async (cmd, args, opts) => {
      expect(cmd).toBe("gh")
      expect(opts.cwd).toBe("/repo")
      calls.push(args)
      return { code: 0, stdout: empty, stderr: "" }
    }, "/repo", pr)
    expect(result).toEqual(detail)
    expect(calls.map((c) => c[1])).toEqual([
      "repos/o/r/pulls/7/comments?per_page=100",
      "repos/o/r/pulls/7/reviews?per_page=100", "repos/o/r/issues/7/comments?per_page=100",
    ])
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.includes("--paginate") && c.includes("--slurp"))).toBe(true)
  })

  test("fetch fails rather than presenting partial feedback as complete", async () => {
    await expect(fetchDetail(async () => ({ code: 1, stdout: "", stderr: "rate limited" }), "/repo", pr)).rejects.toThrow("rate limited")
    await expect(fetchDetail(async () => { throw new Error("spawn failed") }, "/repo", pr)).rejects.toThrow("spawn failed")
  })
})

describe("preview cache", () => {
  test("deduplicates in-flight loads and caches success and errors until refresh", async () => {
    const cache = new PreviewCache()
    const pending = deferred<PrDetail>()
    let calls = 0
    let changed = 0
    const load = () => { calls++; return pending.promise }
    const notify = () => { changed++ }
    expect(cache.get(pr, load, notify).state).toBe("loading")
    expect(cache.get(pr, load, notify).state).toBe("loading")
    await tick()
    expect(calls).toBe(1)
    pending.resolve(detail)
    await tick()
    expect(cache.get(pr, load, notify)).toEqual({ state: "ready", detail })
    expect(changed).toBe(1)
    cache.clear()
    cache.get(pr, async () => { throw new Error("failed") }, notify)
    await tick()
    expect(cache.get(pr, load, notify)).toEqual({ state: "error", error: "failed" })
    expect(calls).toBe(1)
  })

  test("old requests cannot overwrite refreshed data or signal changes", async () => {
    const cache = new PreviewCache()
    const old = deferred<PrDetail>()
    let changed = 0
    const notify = () => { changed++ }
    cache.get(pr, () => old.promise, notify)
    cache.clear()
    cache.get(pr, async () => detail, notify)
    await tick()
    old.resolve({ threads: [{ kind: "comment", messages: [{ id: 1, author: "old", body: "obsolete", at: "" }] }] })
    await tick()
    expect(cache.get(pr, async () => detail, notify)).toEqual({ state: "ready", detail })
    expect(changed).toBe(1)
  })

  test("a reopened browser is notified about an already pending request", async () => {
    const cache = new PreviewCache()
    const pending = deferred<PrDetail>()
    let oldRenders = 0
    let newRenders = 0
    const oldBrowser = () => { oldRenders++ }
    const newBrowser = () => { newRenders++ }
    const load = () => pending.promise
    cache.get(pr, load, oldBrowser)
    cache.get(pr, load, newBrowser)
    cache.get(pr, load, newBrowser)
    pending.resolve(detail)
    await tick()
    expect(oldRenders).toBe(1)
    expect(newRenders).toBe(1)
  })

  test("cache keys include repository and PR number", async () => {
    const cache = new PreviewCache()
    const other = { ...pr, repo: "different/repo" }
    cache.get(pr, async () => detail, () => {})
    const otherDetail: PrDetail = { threads: [{ kind: "comment", messages: [{ id: 1, author: "other", body: "other", at: "" }] }] }
    cache.get(other, async () => otherDetail, () => {})
    await tick()
    expect(cache.get(pr, async () => detail, () => {})).toEqual({ state: "ready", detail })
    expect(cache.get(other, async () => detail, () => {})).toEqual({ state: "ready", detail: otherDetail })
  })
})
