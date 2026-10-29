import type { Pr } from "./model"

export interface Message {
  id: number
  author: string
  body: string
  at: string
}

export interface CommentThread {
  kind: "inline" | "review" | "comment"
  path?: string
  line?: number
  messages: Message[]
}

export interface PrDetail {
  threads: CommentThread[]
}

interface Comment {
  id: number
  user: { login: string } | null
  body: string | null
  created_at: string
  submitted_at?: string | null
  path?: string
  line?: number | null
  original_line?: number | null
  in_reply_to_id?: number
}

/** Each collection is gh --paginate --slurp output, including every page. */
export function parseDetail(inline: string, reviews: string, comments: string): PrDetail {
  const pages = (json: string): Comment[] => {
    const data: unknown = JSON.parse(json)
    if (!Array.isArray(data) || !data.every(Array.isArray)) throw new Error("expected paginated arrays")
    return data.flat() as Comment[]
  }
  const inlineComments = pages(inline)
  const byId = new Map(inlineComments.map((c) => [c.id, c]))
  const convert = (c: Comment): Message => ({
    id: c.id, author: c.user?.login ?? "ghost", body: c.body ?? "",
    at: c.submitted_at ?? c.created_at,
  })
  const inlineThreads = new Map<number, CommentThread>()
  for (const c of inlineComments) {
    const rootId = c.in_reply_to_id ?? c.id
    let thread = inlineThreads.get(rootId)
    if (!thread) {
      const root = byId.get(rootId) ?? c
      thread = {
        kind: "inline", messages: [],
        ...(root.path ? { path: root.path } : {}),
        ...(root.line ?? root.original_line ? { line: (root.line ?? root.original_line)! } : {}),
      }
      inlineThreads.set(rootId, thread)
    }
    thread.messages.push(convert(c))
  }
  const threads: CommentThread[] = [
    ...inlineThreads.values(),
    ...pages(reviews).filter((c) => c.submitted_at && c.body?.trim())
      .map((c): CommentThread => ({ kind: "review", messages: [convert(c)] })),
    ...pages(comments).map((c): CommentThread => ({ kind: "comment", messages: [convert(c)] })),
  ]
  const chronological = (a: Message, b: Message) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id
  for (const thread of threads) thread.messages.sort(chronological)
  threads.sort((a, b) => chronological(b.messages.at(-1)!, a.messages.at(-1)!))
  return { threads }
}

type Exec = (cmd: string, args: string[], opts: { cwd: string }) => Promise<{
  code: number; stdout: string; stderr: string
}>

export async function fetchDetail(exec: Exec, cwd: string, pr: Pr): Promise<PrDetail> {
  const base = `repos/${pr.repo}`
  const pull = `${base}/pulls/${pr.number}`
  const get = async (path: string) => {
    const r = await exec("gh", ["api", path, "--paginate", "--slurp"], { cwd })
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `gh exited ${r.code}`)
    return r.stdout
  }
  const [inline, reviews, comments] = await Promise.all([
    get(`${pull}/comments?per_page=100`), get(`${pull}/reviews?per_page=100`),
    get(`${base}/issues/${pr.number}/comments?per_page=100`),
  ])
  return parseDetail(inline, reviews, comments)
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
