import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { injectContext } from "./context-pins"

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

/**
 * Split `<address> [note]`: the first word is the address, the rest an
 * optional note appended to the injected orientation.
 */
export function parseInjectArgs(args: string): { address?: string; note?: string } {
  const [first = "", ...rest] = args.trim().split(/\s+/)
  const note = rest.join(" ").trim()
  return { address: parseAddress(first), note: note || undefined }
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
  const { address, note } = parseInjectArgs(args)
  if (!address) {
    ctx.ui.notify(
      "cue: usage /cue:context:inject <org>/<repo>/<context> [note]",
      "warning",
    )
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
  await injectContext(pi, ctx, address, note)
}

/**
 * Register `/cue:context:inject <address>`: inject any context, pinned
 * or not and from any scope, exactly as `/cue:context:pins` does.
 */
export function registerContextInjectCommand(pi: ExtensionAPI): void {
  pi.registerCommand("cue:context:inject", {
    description: "Inject a cue context by canonical address <org>/<repo>/<ctx> [note]",
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
