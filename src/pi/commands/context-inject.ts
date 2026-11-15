import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { ExploreError, handoffBriefing } from "../lib/context-explore"
import { injectContext } from "./context-pins"

const USAGE =
  "cue: usage /cue:context:inject <org>/<repo>/<context> " +
  "[--handoff <org>/<repo>/<context>/trace/<handoff>] [note]"

/**
 * Normalise the command argument to a canonical context address
 * (`<org>/<repo>/<slug>`): trim, drop surrounding slashes. Returns
 * undefined unless exactly three non-empty segments remain.
 */
export function parseAddress(args: string): string | undefined {
  const parts = args.trim().split("/").filter((p) => p !== "")
  if (parts.length !== 3 || parts.some((p) => /\s/.test(p))) return undefined
  return parts.join("/")
}

export interface InjectArgs {
  address?: string
  /** Hand-off trace address to inject in full, when one was selected. */
  handoff?: string
  note?: string
  /** Set when `--handoff` is given without an address. */
  missingHandoff?: boolean
}

/**
 * Split `<address> [--handoff <trace-address>] [note]`: the first word
 * is the address, an optional `--handoff` names one hand-off trace to
 * inject in full, and the rest (verbatim) is an optional note appended
 * to the injected orientation.
 */
export function parseInjectArgs(args: string): InjectArgs {
  // The note keeps its line breaks: PR sessions pass a multi-line block.
  const m = /^\s*(\S*)\s*([\s\S]*?)\s*$/.exec(args)!
  const address = parseAddress(m[1]!)
  const flag = /^--handoff(?=\s|$)\s*(\S*)\s*([\s\S]*)$/.exec(m[2]!)
  if (!flag) return { address, note: m[2] || undefined }
  if (!flag[1]) return { address, missingHandoff: true }
  return { address, handoff: flag[1], note: flag[2] || undefined }
}

/** The inject command arguments for a context, optional hand-off and note. */
export function injectArgs(address: string, opts: { handoff?: string; note?: string } = {}): string {
  return [address, opts.handoff ? `--handoff ${opts.handoff}` : "", opts.note ?? ""]
    .filter((s) => s !== "")
    .join(" ")
}

/** Every context address in the store, for argument completion. */
async function storeAddresses(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string[]> {
  try {
    const r = await pi.exec(
      "cue",
      ["context", "list", "--scope", "store"],
      { cwd },
    )
    if (r.code !== 0) return []
    return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "")
  } catch {
    return []
  }
}

async function handler(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionContext,
): Promise<void> {
  const { address, note, handoff, missingHandoff } = parseInjectArgs(args)
  if (!address || missingHandoff) {
    ctx.ui.notify(USAGE, "warning")
    return
  }
  const status = await pi.exec("cue", ["status", "--context", address], {
    cwd: ctx.cwd,
  })
  if (status.code !== 0) {
    ctx.ui.notify(`cue: no such context ${address}`, "error")
    return
  }
  if (!ctx.isIdle()) {
    ctx.ui.notify("cue: wait for the agent to finish to inject", "warning")
    return
  }
  let selected: { address: string; briefing: string } | undefined
  if (handoff) {
    try {
      selected = await handoffBriefing(pi, ctx.cwd, address, handoff)
    } catch (e) {
      if (!(e instanceof ExploreError)) throw e
      ctx.ui.notify(`cue: hand-off not injected: ${e.message}`, "error")
      return
    }
  }
  await injectContext(pi, ctx, address, note, selected)
}

/**
 * Register `/cue:context:inject <address>`: inject any context, pinned
 * or not and from any scope, exactly as `/cue:context:pins` does.
 */
export function registerContextInjectCommand(pi: ExtensionAPI): void {
  pi.registerCommand("cue:context:inject", {
    description:
      "Inject a cue context by canonical address <org>/<repo>/<ctx> " +
      "[--handoff <hand-off trace address>] [note]",
    getArgumentCompletions: async (prefix) => {
      const p = prefix.trim()
      const items = (await storeAddresses(pi, process.cwd()))
        .filter((a) => a.includes(p))
        .map((a) => ({ value: a, label: a }))
      return items.length > 0 ? items : null
    },
    handler: async (args, ctx) => handler(pi, args, ctx),
  })
}
