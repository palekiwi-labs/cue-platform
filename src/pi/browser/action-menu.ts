import type { KeybindingsManager } from "@earendil-works/pi-coding-agent"
import { type Component, type KeyId, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { type Binding, keyName } from "./keymap"

/** Opens the item-actions menu inside a view. */
export const ACTIONS_KEY: KeyId = "f3"

export type MenuSection = "open" | "act" | "copy"

export const SECTIONS: MenuSection[] = ["open", "act", "copy"]

const FOOTER = "enter run • esc close"
const GAP = 3

interface MenuTheme {
  fg(color: any, text: string): string
  bold(text: string): string
}

/** Bindings tagged for the menu, as columns in section order; empty sections dropped. */
export function menuColumns(bindings: Binding[]): { section: MenuSection; rows: Binding[] }[] {
  return SECTIONS.map((section) => ({
    section,
    rows: bindings.filter((b) => b.menu === section && b.run),
  })).filter((c) => c.rows.length > 0)
}

const cellWidth = (b: Binding) => 2 + visibleWidth(b.label) + 2 + visibleWidth(keyName(b))

function columnWidth(c: { section: MenuSection; rows: Binding[] }): number {
  return Math.max(visibleWidth(c.section), ...c.rows.map(cellWidth))
}

/** Width of the boxed menu for these bindings. */
export function actionMenuWidth(bindings: Binding[], title: string): number {
  const cols = menuColumns(bindings)
  const body = cols.reduce((n, c) => n + columnWidth(c), 0) + GAP * Math.max(0, cols.length - 1)
  return Math.max(body, visibleWidth(title) + 2, visibleWidth(FOOTER) + 2) + 4
}

/**
 * Boxed popup of item actions in section columns: up/down move within a
 * column, left/right between columns, enter runs the action.
 */
export class ActionMenu implements Component {
  col = 0
  row = 0
  private cols: { section: MenuSection; rows: Binding[] }[]

  constructor(
    private theme: MenuTheme,
    private kb: KeybindingsManager,
    private title: string,
    bindings: Binding[],
    private finish: (b: Binding | null) => void,
  ) {
    this.cols = menuColumns(bindings)
  }

  invalidate(): void {}

  current(): Binding | undefined {
    return this.cols[this.col]?.rows[this.row]
  }

  moveRow(delta: number): void {
    const n = this.cols[this.col]?.rows.length ?? 0
    if (n > 0) this.row = (this.row + delta + n) % n
  }

  moveCol(delta: number): void {
    const n = this.cols.length
    if (n === 0) return
    this.col = (this.col + delta + n) % n
    this.row = Math.min(this.row, this.cols[this.col]!.rows.length - 1)
  }

  handleInput(data: string): void {
    if (this.kb.matches(data, "tui.select.up")) this.moveRow(-1)
    else if (this.kb.matches(data, "tui.select.down")) this.moveRow(1)
    else if (matchesKey(data, "left")) this.moveCol(-1)
    else if (matchesKey(data, "right")) this.moveCol(1)
    else if (this.kb.matches(data, "tui.select.confirm")) this.finish(this.current() ?? null)
    else if (this.kb.matches(data, "tui.select.cancel") || matchesKey(data, ACTIONS_KEY)) this.finish(null)
  }

  render(width: number): string[] {
    const t = this.theme
    const inner = Math.max(1, width - 4)
    const widths = this.cols.map(columnWidth)
    const cells = this.cols.map((c, ci) => {
      const labelWidth = Math.max(0, ...c.rows.map((b) => visibleWidth(b.label)))
      return [
        t.fg("accent", c.section),
        ...c.rows.map((b, ri) => {
          const label = b.label.padEnd(labelWidth)
          const key = t.fg("warning", keyName(b))
          return ci === this.col && ri === this.row
            ? t.fg("accent", "> " + t.bold(label)) + "  " + key
            : "  " + t.fg("muted", label) + "  " + key
        }),
      ]
    })
    const height = Math.max(0, ...cells.map((c) => c.length))
    const body: string[] = []
    for (let r = 0; r < height; r++) {
      body.push(cells.map((c, ci) => {
        const cell = c[r] ?? ""
        return cell + " ".repeat(Math.max(0, widths[ci]! - visibleWidth(cell)))
      }).join(" ".repeat(GAP)))
    }
    const border = (s: string) => t.fg("border", s)
    const head = ` ${this.title} `
    const foot = ` ${FOOTER} `
    const top = border("╭─") + t.fg("accent", t.bold(head)) +
      border("─".repeat(Math.max(0, width - 3 - visibleWidth(head))) + "╮")
    const bottom = border("╰" + "─".repeat(Math.max(0, width - 3 - visibleWidth(foot)))) +
      t.fg("dim", foot) + border("─╯")
    const row = (s: string) => {
      const cut = truncateToWidth(s, inner, "…")
      return border("│ ") + cut + " ".repeat(Math.max(0, inner - visibleWidth(cut))) + border(" │")
    }
    return [top, ...body.map(row), bottom].map((l) => truncateToWidth(l, width))
  }
}
