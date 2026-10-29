import type { Pr } from "./model"

export interface Feedback {
  kind: "inline" | "review" | "comment"
  id: number
  author: string
  body: string
  at: string
  url: string
  state?: string
  path?: string
  line?: number
  diff?: string
  replyTo?: number
  threadBody?: string
}

export interface PrDetail {
  body: string
  feedback: Feedback[]
}

interface Comment {
  id: number
  user: { login: string } | null
  body: string | null
  created_at: string
  submitted_at?: string | null
  html_url: string
  state?: string
  path?: string
  line?: number | null
  original_line?: number | null
  diff_hunk?: string
  in_reply_to_id?: number
}

/** Each collection is gh --paginate --slurp output, including every page. */
export function parseDetail(detail: string, inline: string, reviews: string, comments: string): PrDetail {
  const pr = JSON.parse(detail)
  if (!pr || (typeof pr.body !== "string" && pr.body !== null)) throw new Error("missing PR body")
  const pages = (json: string): Comment[] => {
    const data: unknown = JSON.parse(json)
    if (!Array.isArray(data) || !data.every(Array.isArray)) throw new Error("expected paginated arrays")
    return data.flat() as Comment[]
  }
  const threads = pages(inline)
  const byId = new Map(threads.map((c) => [c.id, c]))
  const convert = (c: Comment, kind: Feedback["kind"]): Feedback => ({
    kind, id: c.id, author: c.user?.login ?? "ghost", body: c.body ?? "",
    at: c.submitted_at ?? c.created_at, url: c.html_url,
    ...(c.state ? { state: c.state } : {}),
    ...(c.path ? { path: c.path } : {}),
    ...(c.line ?? c.original_line ? { line: (c.line ?? c.original_line)! } : {}),
    ...(c.diff_hunk ? { diff: c.diff_hunk } : {}),
    ...(c.in_reply_to_id ? {
      replyTo: c.in_reply_to_id,
      threadBody: byId.get(c.in_reply_to_id)?.body ?? "Thread root unavailable",
    } : {}),
  })
  const feedback = [
    ...threads.map((c) => convert(c, "inline")),
    ...pages(reviews).filter((c) => c.submitted_at && c.body?.trim()).map((c) => convert(c, "review")),
    ...pages(comments).map((c) => convert(c, "comment")),
  ].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)
  return { body: pr.body ?? "", feedback }
}

type Exec = (cmd: string, args: string[], opts: { cwd: string }) => Promise<{
  code: number; stdout: string; stderr: string
}>

export async function fetchDetail(exec: Exec, cwd: string, pr: Pr): Promise<PrDetail> {
  const base = `repos/${pr.repo}`
  const pull = `${base}/pulls/${pr.number}`
  const get = async (path: string, paginate = false) => {
    const r = await exec("gh", ["api", path, ...(paginate ? ["--paginate", "--slurp"] : [])], { cwd })
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `gh exited ${r.code}`)
    return r.stdout
  }
  const [detail, inline, reviews, comments] = await Promise.all([
    get(pull), get(`${pull}/comments?per_page=100`, true),
    get(`${pull}/reviews?per_page=100`, true), get(`${base}/issues/${pr.number}/comments?per_page=100`, true),
  ])
  return parseDetail(detail, inline, reviews, comments)
}

export type PreviewEntry = { state: "loading" } | { state: "ready"; detail: PrDetail } | { state: "error"; error: string }
export const prKey = (pr: Pr): string => `${pr.repo}#${pr.number}`

/** A refresh replaces the map entries so old in-flight results cannot repopulate it. */
export class PreviewCache {
  private entries = new Map<string, { value: PreviewEntry; listeners: Set<() => void> }>()

  clear(): void { this.entries.clear() }

  get(pr: Pr, load: (pr: Pr) => Promise<PrDetail>, changed: () => void): PreviewEntry {
    const key = prKey(pr)
    const cached = this.entries.get(key)
    if (cached) {
      if (cached.value.state === "loading") cached.listeners.add(changed)
      return cached.value
    }
    const pending = { value: { state: "loading" } as PreviewEntry, listeners: new Set([changed]) }
    this.entries.set(key, pending)
    const finish = (entry: PreviewEntry) => {
      if (this.entries.get(key) !== pending) return
      pending.value = entry
      for (const listener of pending.listeners) listener()
      pending.listeners.clear()
    }
    void Promise.resolve().then(() => load(pr)).then(
      (detail) => finish({ state: "ready", detail }),
      (e) => finish({ state: "error", error: e instanceof Error ? e.message : String(e) }),
    )
    return pending.value
  }
}

const literal = (s: string): string => s.replace(/[\\`*_[\]<>#]/g, "\\$&").replace(/[\r\n]+/g, " ")
const quote = (s: string): string => s.split("\n").map((line) => `> ${line}`).join("\n")

export function detailMarkdown(pr: Pr, detail: PrDetail): string {
  return [
    `## ${literal(pr.repo)} #${pr.number}: ${literal(pr.title)}`,
    `@${literal(pr.author)} · ${pr.isDraft ? "draft" : "open"} · ${literal(pr.headRef)} → ${literal(pr.baseRef)}`,
    `Review: ${pr.reviewDecision ?? "none"} · Checks: ${pr.checks ?? "none"}`,
    pr.url,
    "## Latest feedback (newest first)",
    "All pages fetched; ordered by submission/creation time, not edit time.",
    ...detail.feedback.map((f) => [
      `### ${f.kind}${f.state ? ` ${f.state}` : ""} · @${literal(f.author)} · ${f.at}`,
      ...(f.path ? [`${literal(f.path)}${f.line ? `:${f.line}` : ""} · comment #${f.id}${f.replyTo ? ` · reply to #${f.replyTo}` : " · thread root"}`] : []),
      ...(f.replyTo ? ["Thread root:", quote(f.threadBody ?? "Thread root unavailable")] : []),
      ...(f.diff ? ["Diff context:", quote(f.diff)] : []),
      f.body || "(empty comment)",
      f.url,
    ].join("\n\n")),
    ...(detail.feedback.length ? [] : ["No feedback."]),
    "## Description",
    detail.body || "No description.",
  ].join("\n\n")
}
