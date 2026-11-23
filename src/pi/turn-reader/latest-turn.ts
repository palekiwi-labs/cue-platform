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
  id?: string
  message?: ReaderMessage
}

/** One user turn of a session branch. */
export interface BranchTurn {
  /** The entry id of the user message, else its timestamp or branch position. */
  key: string
  /** Text of each assistant message of the turn, oldest first. */
  texts: string[]
  /** Whether this is the last turn of the branch. */
  latest: boolean
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
 * Every user turn of the branch, oldest first, each with the text of its
 * assistant messages, one entry per message. Thinking, tool calls, tool
 * results and messages without text are left out; turns may have no text.
 * `live` is the assistant message still streaming; it is added to the last
 * turn unless the branch already holds it.
 */
export function branchTurns(branch: readonly BranchEntry[], live?: ReaderMessage): BranchTurn[] {
  const turns: { key: string; messages: ReaderMessage[] }[] = []
  branch.forEach((entry, at) => {
    const message = entry.type === "message" ? entry.message : undefined
    if (message?.role === "user") {
      const key = entry.id ?? (message.timestamp !== undefined ? `t${message.timestamp}` : `#${at}`)
      turns.push({ key, messages: [] })
    } else if (message?.role === "assistant") turns.at(-1)?.messages.push(message)
  })
  const last = turns.at(-1)
  if (last && live?.role === "assistant") {
    const persisted = last.messages.some(
      (m) => m === live || (m.timestamp !== undefined && m.timestamp === live.timestamp),
    )
    if (!persisted) last.messages.push(live)
  }
  return turns.map((turn, i) => ({
    key: turn.key,
    texts: turn.messages.map(assistantText).filter((t) => t !== ""),
    latest: i === turns.length - 1,
  }))
}

/** Text of each assistant message of the branch's latest turn; see `branchTurns`. */
export function latestTurnTexts(branch: readonly BranchEntry[], live?: ReaderMessage): string[] {
  return branchTurns(branch, live).at(-1)?.texts ?? []
}
