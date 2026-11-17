/** A draft comment on one reader chunk, with the chunk source it quotes. */
export interface ChunkComment {
  quote: string
  text: string
}

/** Key of chunk `chunk` (0-based, within its message) of message `message` of the turn. */
export function chunkKey(message: number, chunk: number): string {
  return `${message}:${chunk}`
}

function order(key: string): [number, number] {
  const [m, c] = key.split(":").map(Number)
  return [m ?? 0, c ?? 0]
}

/**
 * Draft comments on the chunks of one turn, at most one per chunk, plus the
 * last text discarded on each chunk (a cancelled compose or a deleted
 * comment) so that composing again resumes it.
 */
export class TurnComments {
  private drafts = new Map<string, ChunkComment>()
  private discarded = new Map<string, string>()
  /** Bumped on every change to the saved comments. */
  version = 0

  get(key: string): ChunkComment | undefined {
    return this.drafts.get(key)
  }

  get size(): number {
    return this.drafts.size
  }

  /** Text a compose on `key` starts from: the last discarded text, else the saved comment. */
  draft(key: string): string {
    return this.discarded.get(key) ?? this.drafts.get(key)?.text ?? ""
  }

  /** Save `text` as the comment on `key`; empty text deletes the comment. */
  save(key: string, quote: string, text: string): void {
    const trimmed = text.trim()
    if (trimmed === "") return this.remove(key)
    this.discarded.delete(key)
    this.drafts.set(key, { quote, text: trimmed })
    this.version++
  }

  /** Delete the comment on `key`, keeping its text for the next compose. */
  remove(key: string): void {
    const old = this.drafts.get(key)
    if (!old) return
    this.discarded.set(key, old.text)
    this.drafts.delete(key)
    this.version++
  }

  /** Remember text left unsaved on `key`, unless it is empty or already saved. */
  discard(key: string, text: string): void {
    if (text.trim() === "" || text.trim() === this.drafts.get(key)?.text) this.discarded.delete(key)
    else this.discarded.set(key, text)
  }

  /** Saved comments in turn order. */
  entries(): [string, ChunkComment][] {
    return [...this.drafts].sort(([a], [b]) => {
      const [am, ac] = order(a)
      const [bm, bc] = order(b)
      return am - bm || ac - bc
    })
  }

  clear(): void {
    this.drafts.clear()
    this.discarded.clear()
    this.version++
  }
}

function quoted(text: string): string {
  return text.split("\n").map((l) => (l.trim() === "" ? ">" : `> ${l}`)).join("\n")
}

/** Reply text: each commented chunk quoted, followed by its comment, in turn order. */
export function replyText(comments: TurnComments): string {
  return comments.entries().map(([, c]) => `${quoted(c.quote)}\n\n${c.text}`).join("\n\n")
}

/** `existing` editor text with `reply` appended after a blank line; non-blank `existing` is kept as is. */
export function appendReply(existing: string, reply: string): string {
  if (existing.trim() === "") return reply
  const gap = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n"
  return existing + gap + reply
}
