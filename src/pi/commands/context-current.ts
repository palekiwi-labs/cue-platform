import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { currentContext } from "../lib/current-context"
import { cueBestEffort } from "./common"
import { injectContext } from "./context-pins"

/**
 * Canonical address from `cue status --json`, or undefined when cue
 * resolves no context (unset, error, or malformed output).
 */
export function parseStatusAddress(stdout: string): string | undefined {
  try {
    const s = JSON.parse(stdout) as { address?: unknown }
    return typeof s?.address === "string" && s.address !== ""
      ? s.address
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The session's active context: the context linked or injected on the
 * current branch first, else cue's own resolution (`$CUE_CONTEXT`, then
 * the git branch configuration) via `cue status`.
 */
export async function resolveActiveContext(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<string | undefined> {
  const fromSession = currentContext(ctx.sessionManager.getBranch())
  if (fromSession) return fromSession
  return parseStatusAddress(
    await cueBestEffort(pi, ctx.cwd, ["status", "--json"]),
  )
}

async function handler(pi: ExtensionAPI, ctx: ExtensionContext) {
  const address = await resolveActiveContext(pi, ctx)
  if (!address) {
    ctx.ui.notify(
      "cue: no active context; pick one with /cue:context:pins",
      "warning",
    )
    return
  }
  if (!ctx.isIdle()) {
    ctx.ui.notify("cue: wait for the agent to finish to inject", "warning")
    return
  }
  await injectContext(pi, ctx.cwd, address)
}

/**
 * Register `/cue:context:current`: inject the active context without a
 * picker and without starting a turn, exactly as `/cue:context:pins`
 * does. Follow it with `/cue:init` for a summary.
 */
export function registerContextCurrentCommand(pi: ExtensionAPI): void {
  pi.registerCommand("cue:context:current", {
    description: "Inject the session's active cue context (no picker)",
    handler: async (_args, ctx) => handler(pi, ctx),
  })
}
