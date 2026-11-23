import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { ExploreError, handoffBriefing, taskBriefing } from "../lib/context-explore"
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
  /** Task artifact to make the session's active task and orientation. */
  task?: string
  /** Hand-off trace address to inject in full, when one was selected. */
  handoff?: string
  note?: string
  /** Set when `--task` or `--handoff` is given without an address. */
  missingFlag?: string
}

/**
 * Split `<address> [--task <task-address>] [--handoff <trace-address>]
 * [note]`: the first word is the address, the flags (in any order, each
 * once) name the task to start on and one hand-off trace to inject in
 * full, and the rest (verbatim) is an optional note appended to the
 * injected orientation.
 */
export function parseInjectArgs(args: string): InjectArgs {
  // The note keeps its line breaks: PR sessions pass a multi-line block.
  const m = /^\s*(\S*)\s*([\s\S]*?)\s*$/.exec(args)!
  const address = parseAddress(m[1]!)
  const out: InjectArgs = { address }
  let rest = m[2] || ""
  const seen = new Set<string>()
  for (;;) {
    const flag = /^(--task|--handoff)(?=\s|$)\s*(\S*)\s*([\s\S]*)$/.exec(rest)
    if (!flag || seen.has(flag[1]!)) break
    seen.add(flag[1]!)
    if (!flag[2]) return { ...out, missingFlag: flag[1]!.slice(2) }
    out[flag[1] === "--task" ? "task" : "handoff"] = flag[2]
    rest = flag[3]
  }
  out.note = rest || undefined
  return out
}

/** The inject command arguments for a context, task, hand-off and note. */
export function injectArgs(
  address: string,
  opts: { task?: string; handoff?: string; note?: string } = {},
): string {
  return [
    address,
    opts.task ? `--task ${opts.task}` : "",
    opts.handoff ? `--handoff ${opts.handoff}` : "",
    opts.note ?? "",
  ]
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
  const { address, note, task, handoff, missingFlag } = parseInjectArgs(args)
  if (!address || missingFlag || (task && handoff)) {
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
  if (task) {
    try {
      selected = await taskBriefing(pi, ctx.cwd, address, task)
    } catch (e) {
      if (!(e instanceof ExploreError)) throw e
      ctx.ui.notify(`cue: task not injected: ${e.message}`, "error")
      return
    }
    await injectContext(pi, ctx, address, note, undefined, selected)
    return
  }
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
