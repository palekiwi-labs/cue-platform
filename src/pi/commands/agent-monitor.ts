import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TUI } from "@earendil-works/pi-tui"
import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"
import { parsePs, type RunRow } from "../agents/model"
import { AgentMonitor, type MonitorDeps } from "../agents/monitor"
import { editInTerminal, openInTmux } from "./cue-browser"

/** Open the cue-agent monitor. */
export const AGENTS_SHORTCUT = "alt+m"

function prompt(runPath: string): string | undefined {
  try {
    return readFileSync(join(runPath, "prompt.md"), "utf8")
  } catch {
    return undefined
  }
}

/**
 * Documents live in the run dir. Runs from before cue-agent wrote
 * response.md, and runs that failed without one, get their response or
 * error from ps written to a temp file instead.
 */
function documentPath(r: RunRow, pane: "prompt" | "response"): string | undefined {
  const own = r.runPath ? join(r.runPath, `${pane}.md`) : ""
  if (own && existsSync(own)) return own
  if (pane === "prompt") return undefined
  const text = r.error ? `**${r.outcome ?? "error"}:** ${r.error}\n\n${r.response ?? ""}` : r.response
  if (!text) return undefined
  const p = join(tmpdir(), `cue-agent-${r.runId}-response.md`)
  writeFileSync(p, text)
  return p
}

/** How far back the monitor lists batches. */
const HISTORY = "7d"

async function openMonitor(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return
  const deps = (tui: TUI): MonitorDeps => ({
    load: async () => {
      const r = await pi.exec("cue-agent", ["ps", "--all", "--since", HISTORY, "--json"], { cwd: ctx.cwd })
      if (r.code !== 0) return { error: (r.stderr || r.stdout).trim() || `ps failed (${r.code})` }
      return { rows: parsePs(r.stdout) }
    },
    prompt,
    documentPath,
    editFile: (path) => editInTerminal(tui, path),
    copy: copyToClipboard,
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
