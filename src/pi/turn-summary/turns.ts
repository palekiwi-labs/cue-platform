export const TURN_SUMMARY_TYPE = "turn-summary"

/** Payload of a stored turn summary entry. */
export interface TurnSummaryData {
  turnId: string
  text: string
}

/** A turn: a user message and the assistant text that answered it. */
export interface Turn {
  id: string
  prompt: string
  text: string
}

interface ContentPart {
  type: string
  text?: string
}

interface BranchEntry {
  type: string
  id: string
  customType?: string
  data?: unknown
  message?: { role: string; content?: string | ContentPart[] }
}

function textOf(content: string | ContentPart[] | undefined): string {
  if (typeof content === "string") return content
  return (content ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join("\n")
}

/** Turns on the branch, oldest first, skipping those with no assistant text. */
export function turnsOf(branch: readonly BranchEntry[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | undefined
  for (const e of branch) {
    if (e.type !== "message" || !e.message) continue
    if (e.message.role === "user") {
      current = { id: e.id, prompt: textOf(e.message.content).trim(), text: "" }
      turns.push(current)
    } else if (e.message.role === "assistant" && current) {
      const text = textOf(e.message.content).trim()
      if (text) current.text = current.text ? `${current.text}\n\n${text}` : text
    }
  }
  return turns.filter((t) => t.text !== "")
}

/** Stored summaries on the branch, keyed by turn id. */
export function storedSummaries(branch: readonly BranchEntry[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of branch) {
    if (e.type !== "custom" || e.customType !== TURN_SUMMARY_TYPE) continue
    const d = e.data as Partial<TurnSummaryData> | undefined
    if (typeof d?.turnId === "string" && typeof d.text === "string") out.set(d.turnId, d.text)
  }
  return out
}
