/**
 * context-breakdown: records a static-prefix snapshot (a context-snapshot
 * custom entry, never sent to the model) at session start and whenever the
 * effective system prompt, tool set or model changes, and registers
 * /context, an overlay breaking the live context down by source with the
 * per-turn cache summary.
 */
import { copyToClipboard, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent"
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import type { Entry, ToolDef } from "../src/pi/context-breakdown/entries"
import { buildReport, formatBreakdown, formatCache, fmtTokens } from "../src/pi/context-breakdown/report"
import { buildSnapshot, isSnapshot, SNAPSHOT_TYPE, type Snapshot } from "../src/pi/context-breakdown/snapshot"

const TEXT_WIDTH = 100
const PAD_X = 2
const CHROME_X = 2 + 2 * PAD_X
const MAX_HEIGHT = 0.85

function liveSnapshot(pi: ExtensionAPI, ctx: ExtensionContext): Snapshot {
  const active = pi.getActiveTools()
  const byName = new Map(pi.getAllTools().map((t) => [t.name, t]))
  const tools: ToolDef[] = active.flatMap((name) => {
    const t = byName.get(name)
    return t ? [{ name: t.name, description: t.description, parameters: t.parameters }] : []
  })
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null
  return buildSnapshot({ systemPrompt: ctx.getSystemPrompt(), tools, activeTools: active, model })
}

function branch(ctx: ExtensionContext): Entry[] {
  return ctx.sessionManager.getBranch() as unknown as Entry[]
}

function lastSnapshotHash(entries: Entry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type === "custom" && e.customType === SNAPSHOT_TYPE && isSnapshot(e.data)) return e.data.hash
  }
  return null
}

function recordSnapshot(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const snap = liveSnapshot(pi, ctx)
  if (lastSnapshotHash(branch(ctx)) === snap.hash) return
  pi.appendEntry(SNAPSHOT_TYPE, snap)
}

function colorLine(line: string, th: Theme): string {
  if (line.startsWith("== ")) return th.fg("accent", th.bold(line))
  if (line.startsWith("  ")) return th.fg("dim", line)
  if (/^\s*turn \d+ .* missed/.test(line) || line.startsWith("misses") || line.startsWith("largest")) return th.fg("warning", line)
  return line
}

class ContextOverlay {
  private offset = 0
  private lines: string[]

  constructor(
    private theme: Theme,
    private rows: () => number,
    private done: () => void,
    lines: string[],
    private title: string,
    private copy: (text: string) => void,
  ) {
    this.lines = lines
  }

  private viewport(): number {
    return Math.max(1, Math.min(Math.floor(this.rows() * MAX_HEIGHT), this.rows() - 2) - 2)
  }

  private maxOffset(): number {
    return Math.max(0, this.lines.length - this.viewport())
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "return") || data === "q") {
      this.done()
      return
    }
    if (data === "y") {
      this.copy([this.title, "", ...this.lines].join("\n"))
      return
    }
    const max = this.maxOffset()
    if (matchesKey(data, "up") || data === "k") this.offset = Math.max(0, this.offset - 1)
    else if (matchesKey(data, "down") || data === "j") this.offset = Math.min(max, this.offset + 1)
    else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - this.viewport())
    else if (matchesKey(data, "pageDown") || data === " ") this.offset = Math.min(max, this.offset + this.viewport())
    else if (data === "g") this.offset = 0
    else if (data === "G") this.offset = max
  }

  render(width: number): string[] {
    const th = this.theme
    const inner = Math.max(1, width - CHROME_X)
    const viewport = this.viewport()
    this.offset = Math.min(this.offset, this.maxOffset())
    const shown = this.lines.slice(this.offset, this.offset + viewport)
    const border = (s: string) => th.fg("borderMuted", s)
    const head = ` ${this.title} `
    const scrolls = this.lines.length > viewport
    const pos = scrolls ? `${this.offset + 1}-${Math.min(this.lines.length, this.offset + viewport)}/${this.lines.length}` : ""
    const foot = ` esc/q close · y copy${scrolls ? ` · j/k g/G · ${pos}` : ""} `
    const top =
      border("╭─") + th.fg("accent", th.bold(head)) + border("─".repeat(Math.max(0, width - 3 - visibleWidth(head))) + "╮")
    const bottom =
      border("╰" + "─".repeat(Math.max(0, width - 3 - visibleWidth(foot)))) + th.fg("dim", foot) + border("─╯")
    const pad = " ".repeat(PAD_X)
    const row = (s: string) => {
      const cut = truncateToWidth(colorLine(s, th), inner, "…")
      const fill = " ".repeat(Math.max(0, inner - visibleWidth(cut)))
      return border("│") + pad + cut + fill + pad + border("│")
    }
    return [top, ...shown.map(row), bottom].map((l) => truncateToWidth(l, width))
  }

  invalidate(): void {}
  dispose(): void {}
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    recordSnapshot(pi, ctx)
  })

  pi.on("turn_start", async (_event, ctx) => {
    recordSnapshot(pi, ctx)
  })

  pi.registerCommand("context", {
    description: "Break the current context down by source, with per-turn cache use",
    handler: async (_args, ctx) => {
      const live = liveSnapshot(pi, ctx)
      const report = buildReport({
        entries: branch(ctx),
        live,
        contextWindow: ctx.model?.contextWindow ?? null,
      })
      const lines = [
        "== breakdown ==",
        ...formatBreakdown(report, { top: 5, barWidth: 20 }),
        "",
        "== cache ==",
        ...formatCache(report, { turns: 15, misses: 8 }),
      ]
      const total = report.breakdown.exact ?? report.breakdown.estimate
      const title = `context · ${fmtTokens(total)} tokens`
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          const backdrop = tui.showOverlay(
            {
              render: (width) => Array(tui.terminal.rows).fill(" ".repeat(width)),
              invalidate: () => {},
            },
            { anchor: "top-left", width: "100%", maxHeight: "100%", nonCapturing: true },
          )
          const close = () => {
            backdrop.hide()
            done()
          }
          const copy = (text: string) => {
            copyToClipboard(text).then(
              () => ctx.ui.notify("context report copied", "info"),
              (err) => ctx.ui.notify(`copy failed: ${err instanceof Error ? err.message : String(err)}`, "error"),
            )
          }
          return new ContextOverlay(theme, () => tui.terminal.rows, close, lines, title, copy)
        },
        {
          overlay: true,
          overlayOptions: () => ({
            anchor: "center",
            width: Math.max(CHROME_X + 1, Math.min(TEXT_WIDTH + CHROME_X, process.stdout.columns || 80)),
            margin: { top: 1, bottom: 1 },
          }),
        },
      )
    },
  })
}
