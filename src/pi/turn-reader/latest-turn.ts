interface ContentPart {
  type: string
  text?: string
}

/** A session message as far as the reader needs it. */
export interface ReaderMessage {
  role: string
  content?: string | ContentPart[]
  timestamp?: number
}

interface BranchEntry {
  type: string
  message?: ReaderMessage
}

function assistantText(message: ReaderMessage): string {
  const { content } = message
  if (typeof content === "string") return content.trim()
  return (content ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text!.trim())
    .filter((t) => t !== "")
    .join("\n\n")
}

/**
 * Text of each assistant message since the latest user message, oldest
 * first, one entry per message. Thinking, tool calls, tool results and
 * messages without text are left out. `live` is the assistant message still
 * streaming; it is added unless the branch already holds it.
 */
export function latestTurnTexts(branch: readonly BranchEntry[], live?: ReaderMessage): string[] {
  const messages = branch.flatMap((e) => (e.type === "message" && e.message ? [e.message] : []))
  const start = messages.findLastIndex((m) => m.role === "user")
  if (start < 0) return []
  const turn = messages.slice(start + 1).filter((m) => m.role === "assistant")
  const persisted = live && turn.some((m) => m === live || (m.timestamp !== undefined && m.timestamp === live.timestamp))
  if (live?.role === "assistant" && !persisted) turn.push(live)
  return turn.map(assistantText).filter((t) => t !== "")
}
