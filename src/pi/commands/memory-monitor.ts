import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { fakeSource } from "../memory/fake"
import { MemoryMonitor } from "../memory/monitor"

async function openMemoryMonitor(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return
  const source = fakeSource()
  await ctx.ui.custom<void>(
    (tui, theme, kb, done) => new MemoryMonitor(tui, theme, kb, source, ctx.cwd, () => done()),
    {
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
    },
  )
}

export function registerMemoryMonitor(pi: ExtensionAPI): void {
  pi.registerCommand("cue:memory", {
    description: "Monitor memory formation: levels, reflection runs, commits (full screen)",
    handler: async (_args, ctx) => openMemoryMonitor(ctx),
  })
}
