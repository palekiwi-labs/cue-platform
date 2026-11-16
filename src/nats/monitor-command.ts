import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { openMonitorSource } from "./monitor-source"
import { AgentMonitorView } from "./monitor-view"

/** Open the agent monitor. */
export const AGENT_MONITOR_SHORTCUT = "alt+m"

/** Open the NATS agent monitor as a full-screen overlay. */
export async function openAgentMonitor(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return
  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) =>
      new AgentMonitorView(tui, theme, (callbacks) => openMonitorSource(callbacks), () => done()),
    {
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
    },
  )
}

/** Register the `cue:agent-monitor` command and its shortcut. */
export function registerAgentMonitorCommand(pi: ExtensionAPI): void {
  pi.registerCommand("cue:agent-monitor", {
    description: "Monitor agents live over NATS (full screen)",
    handler: async (_args, ctx) => openAgentMonitor(ctx),
  })
  pi.registerShortcut(AGENT_MONITOR_SHORTCUT, {
    description: "Monitor agents live over NATS (full screen)",
    handler: async (ctx) => openAgentMonitor(ctx),
  })
}
