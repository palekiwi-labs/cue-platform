/**
 * Key tables for pickers: one list of bindings drives key dispatch, the
 * short hint line and the ctrl+/ help popup, so the three cannot drift.
 */

import { type Component, type KeyId, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

export type KeyGroup = "navigate" | "act" | "view" | "copy"

export const GROUPS: KeyGroup[] = ["navigate", "act", "view", "copy"]

export interface Binding {
  /** matchesKey ids; empty for display-only rows handled elsewhere. */
  keys: KeyId[]
  /** Shown instead of keys[0] when set (e.g. "ctrl+up/down"). */
  display?: string
  label: string
  group: KeyGroup
  /** Listed in the short hint line. */
  hint?: boolean
  run?: () => void
}

/**
 * ctrl+/ arrives as itself only under the kitty / csi-u protocols; legacy
 * terminals and tmux without extended-keys send 0x1f, which pi-tui
 * reports as ctrl+_ (and ctrl+-).
 */
export const HELP_KEYS: KeyId[] = ["ctrl+/", "ctrl+_"]

export const keyName = (b: Binding): string => b.display ?? b.keys[0] ?? ""

/** The first binding with a run handler whose keys match data. */
export function findBinding(bindings: Binding[], data: string): Binding | undefined {
  return bindings.find((b) => b.run && b.keys.some((k) => matchesKey(data, k)))
}

export function hintText(bindings: Binding[]): string {
  return bindings
    .filter((b) => b.hint)
    .map((b) => `${keyName(b)} ${b.label}`)
    .join(" • ")
}

interface Block {
  group: KeyGroup
  rows: Binding[]
}

/**
 * Lay groups out as blocks in columns: each block is a heading plus its
 * rows; blocks go to the currently shortest column. Returns plain
 * (unstyled) cells so the caller decides colours.
 */
export function layoutHelp(
  bindings: Binding[],
  maxWidth: number,
): { columns: Block[][]; keyWidth: number; colWidth: number } {
  const blocks: Block[] = GROUPS.map((group) => ({
    group,
    rows: bindings.filter((b) => b.group === group),
  })).filter((b) => b.rows.length > 0)
  const keyWidth = Math.max(0, ...bindings.map((b) => visibleWidth(keyName(b))))
  const labelWidth = Math.max(0, ...bindings.map((b) => visibleWidth(b.label)))
  const colWidth = keyWidth + 2 + labelWidth
  const gap = 4
  const fit = Math.max(1, Math.floor((maxWidth + gap) / (colWidth + gap)))
  const n = Math.max(1, Math.min(fit, blocks.length))
  const columns: Block[][] = Array.from({ length: n }, () => [])
  const heights = new Array(n).fill(0)
  for (const block of blocks) {
    const i = heights.indexOf(Math.min(...heights))
    columns[i]!.push(block)
    heights[i] += block.rows.length + (heights[i] > 0 ? 2 : 1)
  }
  return { columns, keyWidth, colWidth }
}

interface HelpTheme {
  fg(color: any, text: string): string
  bold(text: string): string
}

/** Popup listing a key table, shown over the picker with tui.showOverlay. */
export class KeyHelp implements Component {
  private scroll = 0

  constructor(
    private theme: HelpTheme,
    private title: string,
    private bindings: Binding[],
    private close: () => void,
    private maxRows: () => number,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || HELP_KEYS.some((k) => matchesKey(data, k))) return this.close()
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) this.scroll = Math.max(0, this.scroll - 1)
    else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) this.scroll++
  }

  render(width: number): string[] {
    const t = this.theme
    const inner = Math.max(1, width - 4)
    const { columns, keyWidth, colWidth } = layoutHelp(this.bindings, inner)
    const cols = columns.map((blocks) => {
      const lines: string[] = []
      for (const block of blocks) {
        if (lines.length) lines.push("")
        lines.push(t.fg("accent", block.group))
        for (const b of block.rows) {
          const k = keyName(b)
          lines.push(t.fg("warning", k) + " ".repeat(keyWidth - visibleWidth(k) + 2) + t.fg("muted", b.label))
        }
      }
      return lines
    })
    const height = Math.max(...cols.map((c) => c.length))
    const body: string[] = []
    for (let r = 0; r < height; r++) {
      body.push(cols.map((c) => {
        const cell = c[r] ?? ""
        return cell + " ".repeat(Math.max(0, colWidth - visibleWidth(cell)))
      }).join("    "))
    }
    const room = Math.max(1, this.maxRows() - 4)
    this.scroll = Math.max(0, Math.min(this.scroll, body.length - room))
    const shown = body.slice(this.scroll, this.scroll + room)
    const more = body.length > room ? ` ${this.scroll + shown.length}/${body.length}` : ""

    const border = (s: string) => t.fg("border", s)
    const head = ` ${this.title} `
    const foot = ` esc close${more} `
    const top = border("╭─") + t.fg("accent", t.bold(head)) +
      border("─".repeat(Math.max(0, width - 3 - visibleWidth(head))) + "╮")
    const bottom = border("╰" + "─".repeat(Math.max(0, width - 3 - visibleWidth(foot)))) +
      t.fg("dim", foot) + border("─╯")
    const row = (s: string) => {
      const cut = truncateToWidth(s, inner, "…")
      return border("│ ") + cut + " ".repeat(Math.max(0, inner - visibleWidth(cut))) + border(" │")
    }
    return [top, ...shown.map(row), bottom].map((l) => truncateToWidth(l, width))
  }
}

/** Width a popup needs for these bindings, capped to the terminal. */
export function helpWidth(bindings: Binding[], termWidth: number): number {
  const max = Math.max(20, termWidth - 4)
  const { columns, colWidth } = layoutHelp(bindings, max - 4)
  const title = 20
  return Math.min(max, Math.max(title, columns.length * colWidth + (columns.length - 1) * 4) + 4)
}
