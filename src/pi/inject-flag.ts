import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { injectContext } from "./commands/context-pins"
import { parseAddress } from "./commands/context-inject"
import type { ActivityCtx } from "./lib/activity"
import { type BranchEntry, currentContext } from "./lib/current-context"

export const INJECT_FLAG = "cue-inject"

type StartCtx = ActivityCtx & {
  sessionManager: ActivityCtx["sessionManager"] & {
    getBranch(): readonly BranchEntry[]
  }
}

/**
 * Register `--cue-inject <address>`: on session start, inject the
 * context unless the session is already linked to one, so a session
 * resumed with the same flag is not injected twice.
 */
export function registerInjectFlag(
  pi: ExtensionAPI,
  inject: (pi: ExtensionAPI, ctx: StartCtx, address: string) => Promise<void> = injectContext,
): void {
  pi.registerFlag(INJECT_FLAG, {
    description: "Inject a cue context on start when the session has none",
    type: "string",
  })
  pi.on("session_start", async (_e, ctx) => {
    const raw = pi.getFlag(INJECT_FLAG)
    if (typeof raw !== "string" || raw === "") return
    const start = ctx as unknown as StartCtx
    if (currentContext(start.sessionManager.getBranch())) return
    const address = parseAddress(raw)
    if (!address) {
      if (ctx.hasUI) ctx.ui.notify(`cue: --${INJECT_FLAG} needs <org>/<repo>/<context>, got ${raw}`, "warning")
      return
    }
    await inject(pi, start, address)
  })
}
