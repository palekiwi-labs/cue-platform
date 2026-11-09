import { copyToClipboard, type ExtensionAPI, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent"
import { type Component, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { autoSummary } from "../turn-summary/settings"
import { summarizeTurn } from "../turn-summary/summarize"
import { storedSummaries, TURN_SUMMARY_TYPE, type Turn, type TurnSummaryData, turnsOf } from "../turn-summary/turns"

/** Open the turn summary popup. */
export const SUMMARY_SHORTCUT = "f4"

const FOOTER = "← → turns • ctrl+y copy • esc close"

const pending = new Map<string, Promise<string>>()

/** Summarize a turn once: concurrent requests for the same turn share one run. */
function ensureSummary(pi: ExtensionAPI, turn: Turn, cwd: string): Promise<string> {
  let p = pending.get(turn.id)
  if (!p) {
    p = summarizeTurn(turn.prompt, turn.text, cwd).then((text) => {
      const data: TurnSummaryData = { turnId: turn.id, text }
      pi.appendEntry(TURN_SUMMARY_TYPE, data)
      return text
    })
    p.catch(() => {}).finally(() => pending.delete(turn.id))
    pending.set(turn.id, p)
  }
  return p
}

type Slot = { state: "ready"; text: string } | { state: "loading" } | { state: "error"; text: string }

class SummaryPopup implements Component {
  private index: number
  private slots = new Map<string, Slot>()
  private flash = ""

  constructor(
    private pi: ExtensionAPI,
    private cwd: string,
    private tui: TUI,
    private theme: Theme,
    private turns: Turn[],
    stored: Map<string, string>,
  ) {
    this.index = turns.length - 1
    for (const [id, text] of stored) this.slots.set(id, { state: "ready", text })
    this.load()
  }

  invalidate(): void {}

  clearFlash(): void {
    this.flash = ""
  }

  move(delta: number): void {
    const next = Math.min(this.turns.length - 1, Math.max(0, this.index + delta))
    if (next === this.index) return
    this.index = next
    this.load()
  }

  copy(): void {
    const slot = this.slots.get(this.turns[this.index]!.id)
    if (slot?.state !== "ready") return
    copyToClipboard(slot.text).then(
      () => (this.flash = "copied"),
      (err) => (this.flash = `copy failed: ${(err as Error).message}`),
    ).finally(() => this.tui.requestRender())
  }

  private load(): void {
    const turn = this.turns[this.index]
    if (!turn || this.slots.get(turn.id)?.state === "ready") return
    if (this.slots.get(turn.id)?.state === "loading") return
    this.slots.set(turn.id, { state: "loading" })
    ensureSummary(this.pi, turn, this.cwd).then(
      (text) => this.slots.set(turn.id, { state: "ready", text }),
      (err) => this.slots.set(turn.id, { state: "error", text: (err as Error).message ?? String(err) }),
    ).finally(() => this.tui.requestRender())
  }

  render(width: number): string[] {
    const t = this.theme
    const inner = Math.max(1, width - 4)
    const turn = this.turns[this.index]!
    const slot = this.slots.get(turn.id)
    const head = ` turn ${this.index + 1}/${this.turns.length} `
    const prompt = t.fg("dim", truncateToWidth(turn.prompt.replace(/\s+/g, " "), inner, "…"))
    const body =
      slot?.state === "ready"
        ? wrapTextWithAnsi(slot.text, inner)
        : slot?.state === "error"
          ? wrapTextWithAnsi(t.fg("error", `summary failed: ${slot.text}`), inner)
          : [t.fg("dim", "summarizing…")]
    const border = (s: string) => t.fg("border", s)
    const foot = ` ${this.flash || FOOTER} `
    const top = border("╭─") + t.fg("accent", t.bold(head)) +
      border("─".repeat(Math.max(0, width - 3 - visibleWidth(head))) + "╮")
    const bottom = border("╰" + "─".repeat(Math.max(0, width - 3 - visibleWidth(foot)))) +
      t.fg("dim", foot) + border("─╯")
    const row = (s: string) => {
      const cut = truncateToWidth(s, inner, "…")
      return border("│ ") + cut + " ".repeat(Math.max(0, inner - visibleWidth(cut))) + border(" │")
    }
    return [top, row(prompt), row(""), ...body.map(row), bottom].map((l) => truncateToWidth(l, width))
  }
}

function popupComponent(popup: SummaryPopup, tui: TUI, kb: KeybindingsManager, done: () => void): Component {
  return {
    render: (width) => popup.render(width),
    invalidate: () => popup.invalidate(),
    handleInput(data: string) {
      popup.clearFlash()
      if (matchesKey(data, "ctrl+y")) popup.copy()
      else if (matchesKey(data, "left") || data === "h") popup.move(-1)
      else if (matchesKey(data, "right") || data === "l") popup.move(1)
      else if (kb.matches(data, "tui.select.cancel") || matchesKey(data, SUMMARY_SHORTCUT) || data === "q") {
        return done()
      }
      tui.requestRender()
    },
  }
}

export async function openTurnSummary(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return
  const branch = ctx.sessionManager.getBranch() as Parameters<typeof turnsOf>[0]
  const turns = turnsOf(branch)
  if (turns.length === 0) {
    ctx.ui.notify("No turn to summarize yet", "info")
    return
  }
  const stored = storedSummaries(branch)
  await ctx.ui.custom<void>(
    (tui, theme, kb, done) =>
      popupComponent(new SummaryPopup(pi, ctx.cwd, tui, theme, turns, stored), tui, kb, () => done()),
    { overlay: true, overlayOptions: { anchor: "center", width: "70%" } },
  )
}

/** Summarize the turn that just ended, unless it already has a summary. */
function summarizeLastTurn(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const branch = ctx.sessionManager.getBranch() as Parameters<typeof turnsOf>[0]
  const last = turnsOf(branch).at(-1)
  if (!last || storedSummaries(branch).has(last.id)) return
  ensureSummary(pi, last, ctx.cwd).catch((err) => {
    if (ctx.hasUI) ctx.ui.notify(`turn summary failed: ${(err as Error).message ?? String(err)}`, "warning")
  })
}

export function registerTurnSummary(pi: ExtensionAPI): void {
  pi.on("agent_end", (_event, ctx) => {
    if (autoSummary()) summarizeLastTurn(pi, ctx)
  })
  pi.registerCommand("cue:summary", {
    description: "Show a short summary of the last turn and browse earlier ones",
    handler: async (_args, ctx) => openTurnSummary(pi, ctx),
  })
  pi.registerShortcut(SUMMARY_SHORTCUT, {
    description: "Show turn summaries",
    handler: async (ctx) => openTurnSummary(pi, ctx),
  })
}
