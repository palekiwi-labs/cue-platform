import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { buildReport, type Thresholds } from "./lib/context-usage"
import type { HasSession } from "./lib/session-thresholds"

/** Window option carrying the session's saturation level for the tmux window picker. */
export const TMUX_LEVEL_OPTION = "@pi_level"

/** Event the /thresholds command emits with its context after applying new values. */
export const THRESHOLDS_CHANGED_EVENT = "cue-thresholds:changed"

interface UsageContext extends HasSession {
  getContextUsage?: () => { tokens?: number | null } | undefined
}

/** The level to publish for a context, or undefined when the token count is unknown. */
export function levelOf(ctx: UsageContext, thresholds: (ctx: HasSession) => Thresholds): string | undefined {
  const tokens = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage()?.tokens : undefined
  if (typeof tokens !== "number") return undefined
  return buildReport(tokens, thresholds(ctx)).level
}

/**
 * Publish `@pi_level` (nominal | caution | exceeded_soft | critical) on the
 * pane's tmux window, computed from the session's effective thresholds.
 * Only the interactive pi owning the pane publishes.
 */
export function registerTmuxLevel(
  pi: ExtensionAPI,
  thresholds: (ctx: HasSession) => Thresholds,
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): void {
  const pane = env.TMUX_PANE
  if (!env.TMUX || !pane || !isTTY) return
  let last: string | undefined
  const publish = (ctx: UsageContext) => {
    const level = levelOf(ctx, thresholds)
    if (level === undefined || level === last) return
    last = level
    void pi.exec("tmux", ["set-option", "-w", "-t", pane, TMUX_LEVEL_OPTION, level]).catch(() => {})
  }
  pi.on("session_start", (_e, ctx) => {
    last = undefined
    publish(ctx)
  })
  pi.on("agent_end", (_e, ctx) => publish(ctx))
  pi.events.on(THRESHOLDS_CHANGED_EVENT, (ctx: unknown) => publish(ctx as UsageContext))
  pi.on("session_shutdown", async () => {
    await pi.exec("tmux", ["set-option", "-wu", "-t", pane, TMUX_LEVEL_OPTION]).catch(() => {})
  })
}
