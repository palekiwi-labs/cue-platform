import { defaultTarget } from "../lib/default-target"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TUI } from "@earendil-works/pi-tui"
import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isLive, parsePs, type RunRow } from "../agents/model"
import { AgentMonitor, type MonitorDeps, type Pane, type StreamSnapshot } from "../agents/monitor"
import { parseStream, streamLines } from "../agents/stream"
import { EventTail } from "../agents/tail"
import { editInTerminal, newSession, openInTmux } from "./cue-browser"

/** Open the cue-agent monitor. */
export const AGENTS_SHORTCUT = "alt+m"

function prompt(runPath: string): string | undefined {
  try {
    return readFileSync(join(runPath, "prompt.md"), "utf8")
  } catch {
    return undefined
  }
}

/** The run's receipt.json text, when the run dir holds one. */
function readReceipt(runPath: string): string | undefined {
  try {
    return readFileSync(join(runPath, "receipt.json"), "utf8")
  } catch {
    return undefined
  }
}

/** A whole timeline as plain text, nothing truncated by the pane width. */
function timelineText(r: RunRow): string | undefined {
  if (!r.runPath) return undefined
  let text: string
  try {
    text = readFileSync(join(r.runPath, "events.jsonl"), "utf8")
  } catch {
    return undefined
  }
  const state = parseStream(text)
  const body = streamLines(state.items, isLive(r), Number.MAX_SAFE_INTEGER)
    .map((segs) => segs.map((s) => s.text).join(""))
    .join("\n")
  return state.skipped ? `${body}\n… ${state.skipped} unreadable lines\n` : `${body}\n`
}

/**
 * Documents live in the run dir. Runs from before cue-agent wrote
 * response.md, and runs that failed without one, get their response or
 * error from ps written to a temp file instead.
 */
function documentPath(r: RunRow, pane: Pane): string | undefined {
  if (pane === "stream") {
    const text = timelineText(r)
    if (!text) return undefined
    const p = join(tmpdir(), `cue-agent-${r.runId}-stream.txt`)
    writeFileSync(p, text)
    return p
  }
  if (pane === "stats") {
    const p = r.runPath ? join(r.runPath, "receipt.json") : ""
    return p && existsSync(p) ? p : undefined
  }
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

export async function openMonitor(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return
  let tail: { runId: string; tailer: EventTail } | undefined
  const deps = (tui: TUI): MonitorDeps => ({
    load: async () => {
      const r = await pi.exec("cue-agent", ["ps", "--all", "--since", HISTORY, "--json"], { cwd: ctx.cwd })
      if (r.code !== 0) return { error: (r.stderr || r.stdout).trim() || `ps failed (${r.code})` }
      return { rows: parsePs(r.stdout) }
    },
    stream: async (r): Promise<StreamSnapshot | undefined> => {
      if (!r.runPath) return undefined
      if (tail?.runId !== r.runId) {
        tail = { runId: r.runId, tailer: new EventTail(join(r.runPath, "events.jsonl")) }
      }
      const current = tail
      await current.tailer.poll()
      return { runId: current.runId, version: current.tailer.version, items: current.tailer.items() }
    },
    prompt,
    receipt: readReceipt,
    documentPath,
    editFile: (path) => editInTerminal(tui, path),
    copy: copyToClipboard,
    openInTmux,
    newSession: (address, target, note) => newSession(pi, ctx, address, target, note),
  })
  const target = defaultTarget(ctx.sessionManager.getEntries())
  await ctx.ui.custom<void>(
    (tui, theme, kb, done) =>
      new AgentMonitor(tui, theme, kb, deps(tui), () => done(), target),
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
