import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { DEFAULT_THRESHOLDS, type Thresholds } from "../lib/context-usage"
import {
  resolveThresholds,
  setSessionThresholds,
  thresholdsError,
  type ThresholdsSource,
} from "../lib/session-thresholds"
import { THRESHOLDS_CHANGED_EVENT } from "../tmux-level"

/** Context window assumed when the model does not report one. */
export const FALLBACK_WINDOW = 200_000
/** Marker move for left/right and h/l. */
export const STEP = 5_000
/** Marker move for shift+left/right and H/L. */
export const FINE_STEP = 1_000

const MARKERS = ["caution", "soft", "hard"] as const
type Marker = (typeof MARKERS)[number]

const TITLE = "context thresholds"
const FOOTER = "↑↓ select · ←→ 5k · ⇧←→ 1k · r reset · enter apply · esc cancel"
const POPUP_WIDTH = visibleWidth(FOOTER) + 8

interface PopupTheme {
  fg(color: any, text: string): string
  bold(text: string): string
}

/** What the popup shows: the session's thresholds against one context window. */
export interface PopupState {
  thresholds: Thresholds
  /** What `r` resets to: the configured defaults. */
  defaults?: Thresholds
  /** Where the shown values come from. */
  source?: ThresholdsSource
  contextWindow: number
  /** Provider-reported context tokens; null when unknown. */
  tokens: number | null
}

/** Outcome of a key press: apply the edited values, cancel, or keep editing. */
export type PopupResult = { kind: "apply"; thresholds: Thresholds } | { kind: "cancel" }

/** Human label of a thresholds source. */
export function sourceLabel(source: ThresholdsSource): string {
  if (source.kind === "session") return "session"
  if (source.kind === "mode") return `mode ${source.mode}`
  return source.kind
}

function fmt(n: number): string {
  return n.toLocaleString("en-US")
}

function pct(n: number, window: number): string {
  return `${Math.round((n / window) * 100)}%`
}

/** Popup width for a terminal of `cols` columns. */
export function popupWidth(cols: number): number {
  return Math.max(20, Math.min(POPUP_WIDTH, cols))
}

/** Headless thresholds editor: one bar for the window, three movable markers. */
export class ThresholdsPopup implements Component {
  selected = 0
  values: Thresholds

  constructor(
    private theme: PopupTheme,
    private state: PopupState,
  ) {
    this.values = { ...state.thresholds }
  }

  invalidate(): void {}

  /** The marker currently selected. */
  marker(): Marker {
    return MARKERS[this.selected]!
  }

  private bounds(m: Marker): [number, number] {
    const v = this.values
    if (m === "caution") return [FINE_STEP, v.soft - FINE_STEP]
    if (m === "soft") return [v.caution + FINE_STEP, v.hard - FINE_STEP]
    return [v.soft + FINE_STEP, this.state.contextWindow]
  }

  /** Move the selected marker by `delta` tokens, clamped between its neighbours. */
  move(delta: number): void {
    const m = this.marker()
    const [lo, hi] = this.bounds(m)
    const next = this.values[m] + delta
    this.values = { ...this.values, [m]: Math.min(hi, Math.max(lo, next)) }
  }

  /** Validation error of the edited values, or null. */
  error(): string | null {
    return thresholdsError(this.values, this.state.contextWindow)
  }

  /** Handle one key; returns a result when the popup should close. */
  handleInput(data: string): PopupResult | undefined {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return { kind: "cancel" }
    if (matchesKey(data, "return")) {
      if (this.error() !== null) return undefined
      return { kind: "apply", thresholds: { ...this.values } }
    }
    if (matchesKey(data, "up") || matchesKey(data, "shift+tab") || data === "k") {
      this.selected = (this.selected + MARKERS.length - 1) % MARKERS.length
    } else if (matchesKey(data, "down") || matchesKey(data, "tab") || data === "j") {
      this.selected = (this.selected + 1) % MARKERS.length
    } else if (matchesKey(data, "shift+left") || data === "H") this.move(-FINE_STEP)
    else if (matchesKey(data, "shift+right") || data === "L") this.move(FINE_STEP)
    else if (matchesKey(data, "left") || data === "h") this.move(-STEP)
    else if (matchesKey(data, "right") || data === "l") this.move(STEP)
    else if (data === "r") this.values = { ...(this.state.defaults ?? DEFAULT_THRESHOLDS) }
    return undefined
  }

  private column(tokens: number, barWidth: number): number {
    const ratio = Math.min(1, Math.max(0, tokens / this.state.contextWindow))
    return Math.round(ratio * (barWidth - 1))
  }

  private bar(barWidth: number): string[] {
    const t = this.theme
    const { tokens } = this.state
    const used = tokens == null ? -1 : this.column(tokens, barWidth)
    const cells: string[] = []
    for (let i = 0; i < barWidth; i++) cells.push(i <= used ? t.fg("muted", "█") : t.fg("dim", "░"))
    const labels: string[] = Array(barWidth).fill(" ")
    MARKERS.forEach((m, i) => {
      const col = this.column(this.values[m], barWidth)
      const on = i === this.selected
      const color = on ? "accent" : m === "caution" ? "warning" : "error"
      cells[col] = t.fg(color, "│")
      const letter = m[0]!.toUpperCase()
      labels[col] = on ? t.fg("accent", t.bold(letter)) : t.fg(color, letter)
    })
    return [cells.join(""), labels.join("")]
  }

  private body(inner: number): string[] {
    const t = this.theme
    const { contextWindow, tokens } = this.state
    const usage = tokens == null
      ? "unknown"
      : `${fmt(tokens)} (${pct(tokens, contextWindow)})`
    const rows = [
      t.fg("dim", `window ${fmt(contextWindow)} · usage ${usage}` +
        (this.state.source ? ` · from ${sourceLabel(this.state.source)}` : "")),
      ...this.bar(inner),
      "",
    ]
    MARKERS.forEach((m, i) => {
      const on = i === this.selected
      const label = m.padEnd(8)
      const value = fmt(this.values[m]).padStart(9)
      const share = pct(this.values[m], contextWindow).padStart(5)
      const line = `${label}${value} ${share}`
      rows.push(on ? t.fg("accent", "> " + t.bold(line)) : "  " + line)
    })
    const error = this.error()
    if (error !== null) rows.push("", t.fg("error", error))
    return rows
  }

  render(width: number): string[] {
    const t = this.theme
    const inner = Math.max(1, width - 4)
    const border = (s: string) => t.fg("border", s)
    const head = ` ${TITLE} `
    const foot = ` ${FOOTER} `
    const top = border("╭─") + t.fg("accent", t.bold(head)) +
      border("─".repeat(Math.max(0, width - 3 - visibleWidth(head))) + "╮")
    const bottom = border("╰" + "─".repeat(Math.max(0, width - 3 - visibleWidth(foot)))) +
      t.fg("dim", foot) + border("─╯")
    const row = (s: string) => {
      const cut = truncateToWidth(s, inner, "…")
      return border("│ ") + cut + " ".repeat(Math.max(0, inner - visibleWidth(cut))) + border(" │")
    }
    return [top, ...this.body(inner).map(row), bottom].map((l) => truncateToWidth(l, width))
  }
}

/** Popup state for a command context: model window (or the fallback) and provider usage. */
export function popupState(ctx: ExtensionCommandContext): PopupState {
  const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined
  const { thresholds, defaults, source } = resolveThresholds(ctx)
  return {
    thresholds,
    defaults,
    source,
    contextWindow: ctx.model?.contextWindow || FALLBACK_WINDOW,
    tokens: usage?.tokens ?? null,
  }
}

/** Record a popup result in the session; returns the message to show. */
export function applyResult(
  pi: Pick<ExtensionAPI, "appendEntry">,
  result: PopupResult,
  contextWindow: number,
): { message: string; type: "info" | "error" } | null {
  if (result.kind === "cancel") return null
  const error = setSessionThresholds(pi, result.thresholds, contextWindow)
  if (error !== null) return { message: `Thresholds not applied: ${error}`, type: "error" }
  const t = result.thresholds
  return {
    message: `Context thresholds for this session: caution ${fmt(t.caution)} / ` +
      `soft ${fmt(t.soft)} / hard ${fmt(t.hard)}`,
    type: "info",
  }
}

async function openThresholds(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) return
  const state = popupState(ctx)
  const result = await ctx.ui.custom<PopupResult>(
    (tui, theme, _kb, done) => {
      const popup = new ThresholdsPopup(theme, state)
      return {
        render: (width: number) => popup.render(width),
        invalidate: () => popup.invalidate(),
        handleInput(data: string) {
          const outcome = popup.handleInput(data)
          if (outcome) return done(outcome)
          tui.requestRender()
        },
      }
    },
    {
      overlay: true,
      overlayOptions: () => ({ anchor: "center", width: popupWidth(process.stdout.columns || 80) }),
    },
  )
  const shown = applyResult(pi, result, state.contextWindow)
  if (shown) ctx.ui.notify(shown.message, shown.type)
  if (shown?.type === "info") pi.events.emit(THRESHOLDS_CHANGED_EVENT, ctx)
}

/** Register `/thresholds`: adjust this session's saturation thresholds in a popup. */
export function registerThresholdsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("thresholds", {
    description: "Adjust this session's context saturation thresholds",
    handler: async (_args, ctx) => openThresholds(pi, ctx),
  })
}
