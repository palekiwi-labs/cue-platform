import { describe, expect, test } from "bun:test"
import type { Pr } from "./model"
import { detailMarkdown, fetchDetail, parseDetail, type PrDetail, PreviewCache } from "./preview"

const pr = { repo: "o/r", number: 7, title: "Preview", author: "author", headRef: "topic", baseRef: "main" } as Pr
const comment = (id: number, body: string, at = "2026-01-01T00:00:00Z") => ({
  id, body, user: { login: "reviewer" }, created_at: at, html_url: `https://github.com/o/r/pull/7#${id}`,
})
const json = JSON.stringify
const empty = json([[]])
const detail: PrDetail = { body: "Description", feedback: [] }
const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe("PR details", () => {
  test("combines all pages and feedback types newest first with inline thread context", () => {
    const root = { ...comment(1, "Root"), path: "src/file.ts", original_line: 12, diff_hunk: "@@ -1 +1 @@\n+foo" }
    const reply = { ...comment(3, "Reply", "2026-01-04T00:00:00Z"), path: root.path, in_reply_to_id: 1 }
    const parsed = parseDetail(json({ body: "The description" }), json([[root], [reply]]), json([[
      { ...comment(2, "Review body"), submitted_at: "2026-01-03T00:00:00Z", state: "CHANGES_REQUESTED" },
      { ...comment(9, "Pending"), submitted_at: null },
      { ...comment(10, " "), submitted_at: "2026-01-05T00:00:00Z" },
    ]]), json([[{ ...comment(4, "General", "2026-01-02T00:00:00Z"), user: null }]]))
    expect(parsed.feedback.map((f) => [f.id, f.kind])).toEqual([[3, "inline"], [2, "review"], [4, "comment"], [1, "inline"]])
    expect(parsed.feedback[0]).toMatchObject({ replyTo: 1, threadBody: "Root", path: "src/file.ts" })
    expect(parsed.feedback[2]!.author).toBe("ghost")
    expect(parsed.feedback[3]).toMatchObject({ line: 12, diff: root.diff_hunk })
    const md = detailMarkdown(pr, parsed)
    expect(md.indexOf("Reply")).toBeLessThan(md.indexOf("Review body"))
    expect(md.indexOf("## Description")).toBeGreaterThan(md.indexOf("General"))
    expect(md).toContain("reply to #1")
    expect(md).toContain("CHANGES_REQUESTED")
    expect(md).toContain("src/file.ts:12")
    expect(md).toContain("All pages fetched")
  })

  test("handles absent description, missing root and empty feedback; rejects bad data", () => {
    expect(parseDetail(json({ body: null }), empty, empty, empty)).toEqual({ body: "", feedback: [] })
    expect(detailMarkdown(pr, { body: "", feedback: [] })).toContain("No feedback.")
    expect(detailMarkdown(pr, { body: "", feedback: [] })).toContain("No description.")
    const result = parseDetail(json({ body: "" }), json([[{ ...comment(2, "reply"), in_reply_to_id: 99 }]]), empty, empty)
    expect(result.feedback[0]!.threadBody).toBe("Thread root unavailable")
    expect(() => parseDetail("{}", empty, empty, empty)).toThrow("missing PR body")
    expect(() => parseDetail(json({ body: "" }), "{}", empty, empty)).toThrow("paginated arrays")
    expect(() => parseDetail("not json", empty, empty, empty)).toThrow()
  })

  test("fetch explicitly paginates all three collections in the selected repo", async () => {
    const calls: string[][] = []
    const result = await fetchDetail(async (cmd, args, opts) => {
      expect(cmd).toBe("gh")
      expect(opts.cwd).toBe("/repo")
      calls.push(args)
      return { code: 0, stdout: args.includes("--paginate") ? empty : json({ body: "Description" }), stderr: "" }
    }, "/repo", pr)
    expect(result).toEqual(detail)
    expect(calls.map((c) => c[1])).toEqual([
      "repos/o/r/pulls/7", "repos/o/r/pulls/7/comments?per_page=100",
      "repos/o/r/pulls/7/reviews?per_page=100", "repos/o/r/issues/7/comments?per_page=100",
    ])
    expect(calls.slice(1).every((c) => c.includes("--paginate") && c.includes("--slurp"))).toBe(true)
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
    old.resolve({ body: "obsolete", feedback: [] })
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
    cache.get(other, async () => ({ body: "other", feedback: [] }), () => {})
    await tick()
    expect(cache.get(pr, async () => detail, () => {})).toEqual({ state: "ready", detail })
    expect(cache.get(other, async () => detail, () => {})).toEqual({ state: "ready", detail: { body: "other", feedback: [] } })
  })
})
