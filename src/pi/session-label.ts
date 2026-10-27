import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

interface EntryLike {
  id: string
  type: string
  message?: { role?: string }
}

/** Id of the newest user or assistant message on the branch, if any. */
export function lastMessageId(branch: EntryLike[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]
    const role = e.type === "message" ? e.message?.role : undefined
    if (role === "user" || role === "assistant") return e.id
  }
  return undefined
}

/** Distinct labels set on any entry of the session, sorted. */
export function labelsInUse(
  entries: { id: string }[],
  getLabel: (id: string) => string | undefined,
): string[] {
  const labels = new Set<string>()
  for (const e of entries) {
    const label = getLabel(e.id)
    if (label) labels.add(label)
  }
  return [...labels].sort()
}

/**
 * /label <name>: label the last user or assistant message of the
 * session, replacing any label it had. Completion offers labels already
 * used in this session.
 */
export function registerSessionLabel(pi: ExtensionAPI): void {
  let known: string[] = []

  pi.on("session_start", async (_event, ctx) => {
    const sm = ctx.sessionManager
    known = labelsInUse(sm.getEntries(), (id) => sm.getLabel(id))
  })

  pi.registerCommand("label", {
    description: "Label the last message of this session",
    getArgumentCompletions: (prefix) => {
      const items = known
        .filter((l) => l.startsWith(prefix.trim()))
        .map((l) => ({ value: l, label: l }))
      return items.length ? items : null
    },
    handler: async (args, ctx) => {
      const label = args.trim()
      if (!label) {
        ctx.ui.notify("usage: /label <name>", "warning")
        return
      }
      const id = lastMessageId(ctx.sessionManager.getBranch() as EntryLike[])
      if (!id) {
        ctx.ui.notify("No message to label yet", "warning")
        return
      }
      pi.setLabel(id, label)
      if (!known.includes(label)) known = [...known, label].sort()
      ctx.ui.notify(`Labeled last message: ${label}`, "info")
    },
  })
}
