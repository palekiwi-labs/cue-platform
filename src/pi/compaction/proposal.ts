/**
 * Compactor proposal: the JSON the compactor agent returns as its final
 * message. finalize validates it here before touching the store. Only
 * structure is checked; summary faithfulness is trusted to the agent.
 */

export interface ProposedSummary {
  /** Log file names replaced by this summary, oldest first. */
  covers: string[]
  title: string
  found: string[]
  decided: string[]
  open: string[]
  trace: string | null
}

export interface Proposal {
  summaries: ProposedSummary[]
}

/** What finalize knows about the run, taken from the prepare bundle. */
export interface ProposalBounds {
  /** Every snapshotted live log file, oldest first. */
  snapshot: string[]
  /** Files the proposal must replace, exactly and completely. */
  head: string[]
  /** Upper bound on the number of summaries in one proposal. */
  maxSummaries: number
}

export type ProposalResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; errors: string[] }

/** Strip one surrounding markdown code fence, if the agent added it. */
function unfence(text: string): string {
  const match = text.trim().match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
  return match ? match[1] : text.trim()
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
}

function shapeErrors(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ["proposal is not a JSON object"]
  }
  const summaries = (raw as { summaries?: unknown }).summaries
  if (!Array.isArray(summaries)) return ["summaries is not a list"]
  const errors: string[] = []
  summaries.forEach((s, i) => {
    const at = `summaries[${i}]`
    if (typeof s !== "object" || s === null) {
      errors.push(`${at} is not an object`)
      return
    }
    const o = s as Record<string, unknown>
    if (!isStringList(o.covers)) errors.push(`${at}.covers is not a string list`)
    if (typeof o.title !== "string" || o.title.trim() === "") {
      errors.push(`${at}.title is empty`)
    }
    for (const key of ["found", "decided", "open"]) {
      if (!isStringList(o[key])) errors.push(`${at}.${key} is not a string list`)
    }
    if (o.trace !== undefined && o.trace !== null && typeof o.trace !== "string") {
      errors.push(`${at}.trace is not a string or null`)
    }
  })
  return errors
}

function boundsErrors(proposal: Proposal, bounds: ProposalBounds): string[] {
  const errors: string[] = []
  const { summaries } = proposal
  if (summaries.length === 0) errors.push("proposal has no summaries")
  if (summaries.length > bounds.maxSummaries) {
    errors.push(`${summaries.length} summaries exceed the limit of ${bounds.maxSummaries}`)
  }
  const order = new Map(bounds.snapshot.map((file, i) => [file, i]))
  const head = new Set(bounds.head)
  const seen = new Set<string>()
  summaries.forEach((s, i) => {
    const at = `summaries[${i}]`
    if (s.covers.length === 0) errors.push(`${at} covers no entries`)
    for (const file of s.covers) {
      if (!order.has(file)) errors.push(`${at} covers unknown file ${file}`)
      else if (!head.has(file)) errors.push(`${at} covers ${file} outside the head`)
      if (seen.has(file)) errors.push(`${file} is covered more than once`)
      seen.add(file)
    }
    const positions = s.covers.map((f) => order.get(f) ?? -1)
    const contiguous = positions.every((p, j) => j === 0 || p === positions[j - 1] + 1)
    if (!contiguous) errors.push(`${at} covers a non-contiguous range`)
  })
  for (const file of bounds.head) {
    if (!seen.has(file)) errors.push(`head entry ${file} is not covered`)
  }
  return errors
}

/** Parse the agent's final message and validate it against the run. */
export function parseProposal(text: string, bounds: ProposalBounds): ProposalResult {
  let raw: unknown
  try {
    raw = JSON.parse(unfence(text))
  } catch (err) {
    return { ok: false, errors: [`proposal is not valid JSON: ${(err as Error).message}`] }
  }
  const shape = shapeErrors(raw)
  if (shape.length > 0) return { ok: false, errors: shape }
  const o = raw as { summaries: Array<Record<string, unknown>> }
  const proposal: Proposal = {
    summaries: o.summaries.map((s) => ({
      covers: s.covers as string[],
      title: (s.title as string).trim(),
      found: s.found as string[],
      decided: s.decided as string[],
      open: s.open as string[],
      trace: (s.trace as string | null | undefined) ?? null,
    })),
  }
  const errors = boundsErrors(proposal, bounds)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, proposal }
}
