import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { parseManifest, parsePs, type RunManifest } from "../agents/model"
import { AgentMonitor, type MonitorDeps } from "../agents/monitor"

/** Open the cue-agent monitor. */
export const AGENTS_SHORTCUT = "alt+m"

/** Manifests never change once written; cache them for pi's lifetime. */
const manifests = new Map<string, RunManifest>()

function manifest(runPath: string): RunManifest | undefined {
  if (!runPath) return undefined
  let m = manifests.get(runPath)
  if (!m) {
    try {
      m = parseManifest(readFileSync(join(runPath, "manifest.json"), "utf8"))
    } catch {
      return undefined
    }
    manifests.set(runPath, m)
  }
  return m
}

function prompt(runPath: string): string | undefined {
  try {
    return readFileSync(join(runPath, "prompt.md"), "utf8")
  } catch {
    return undefined
  }
}

async function openMonitor(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return
  const deps: MonitorDeps = {
    load: async () => {
      const r = await pi.exec("cue-agent", ["ps", "--all", "--json"], { cwd: ctx.cwd })
      if (r.code !== 0) return { error: (r.stderr || r.stdout).trim() || `ps failed (${r.code})` }
      return { rows: parsePs(r.stdout) }
    },
    manifest,
    prompt,
  }
  await ctx.ui.custom<void>(
    (tui, theme, kb, done) => new AgentMonitor(tui, theme, kb, deps, () => done()),
    {
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
    },
  )
}

export function registerAgentMonitor(pi: ExtensionAPI): void {
  pi.registerCommand("cue:agents", {
    description: "Monitor cue-agent runs (full screen)",
    handler: async (_args, ctx) => openMonitor(pi, ctx),
  })
  pi.registerShortcut(AGENTS_SHORTCUT, {
    description: "Monitor cue-agent runs (full screen)",
    handler: async (ctx) => openMonitor(pi, ctx),
  })
}
