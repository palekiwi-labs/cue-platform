import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TUI } from "@earendil-works/pi-tui"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { parseManifest, parsePs, type RunManifest, type RunRow } from "../agents/model"
import { AgentMonitor, type MonitorDeps } from "../agents/monitor"
import { editInTerminal, openInTmux } from "./cue-browser"

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

/**
 * prompt.md lives in the run dir; the response only exists in ps output,
 * so it is written to a temp file for the editor.
 */
function documentPath(r: RunRow, pane: "prompt" | "response"): string | undefined {
  if (pane === "prompt") {
    const p = join(r.runPath, "prompt.md")
    return r.runPath && existsSync(p) ? p : undefined
  }
  const text = r.error ? `**${r.outcome ?? "error"}:** ${r.error}\n\n${r.response ?? ""}` : r.response
  if (!text) return undefined
  const p = join(tmpdir(), `cue-agent-${r.runId}-response.md`)
  writeFileSync(p, text)
  return p
}

async function openMonitor(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return
  const deps = (tui: TUI): MonitorDeps => ({
    load: async () => {
      const r = await pi.exec("cue-agent", ["ps", "--all", "--json"], { cwd: ctx.cwd })
      if (r.code !== 0) return { error: (r.stderr || r.stdout).trim() || `ps failed (${r.code})` }
      return { rows: parsePs(r.stdout) }
    },
    manifest,
    prompt,
    documentPath,
    editFile: (path) => editInTerminal(tui, path),
    openInTmux,
  })
  await ctx.ui.custom<void>(
    (tui, theme, kb, done) =>
      new AgentMonitor(tui, theme, kb, deps(tui), () => done()),
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
