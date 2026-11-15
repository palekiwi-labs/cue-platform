import type { KeybindingsManager } from "@earendil-works/pi-coding-agent"
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { isHandoffName } from "../lib/context-explore"
import { artifactAddress, type ArtifactRow, compareArtifactsByTime, relativeAge } from "./model"

/** One selectable hand-off of a context. */
export interface HandoffChoice {
  address: string
  name: string
  age: string
}

/** Enter result: the chosen hand-off address, or none. Esc cancels with null. */
export type HandoffPick = { handoff?: string } | null

export const NONE_LABEL = "none: start without a hand-off"

const FOOTER = "enter start • esc cancel"
const MAX_ROWS = 10

interface MenuTheme {
  fg(color: any, text: string): string
  bold(text: string): string
}

/** Hand-off traces of a context, newest first. */
export function handoffChoices(contextAddress: string, rows: ArtifactRow[], now: number): HandoffChoice[] {
  return rows
    .filter((r) => r.type === "trace" && isHandoffName(r.name))
    .sort(compareArtifactsByTime)
    .map((r) => ({
      address: artifactAddress(contextAddress, r.path) ?? `${contextAddress}/trace/${r.name}`,
      name: r.name,
      age: relativeAge(r.createdAt, now),
    }))
}

const rowText = (c: HandoffChoice) => `${c.name}  ${c.age}`

/** Width of the boxed menu for these choices. */
export function handoffMenuWidth(choices: HandoffChoice[], title: string): number {
  const body = 2 + Math.max(visibleWidth(NONE_LABEL), ...choices.map((c) => visibleWidth(rowText(c))))
  return Math.max(body, visibleWidth(title) + 2, visibleWidth(FOOTER) + 2) + 4
}

/**
 * Boxed popup choosing which hand-off a new session starts from: the
 * context's hand-offs newest first (the newest preselected), then an
 * explicit none. Enter picks, esc cancels.
 */
export class HandoffMenu implements Component {
  selected = 0
  private top = 0

  constructor(
    private theme: MenuTheme,
    private kb: KeybindingsManager,
    private title: string,
    private choices: HandoffChoice[],
    private finish: (pick: HandoffPick) => void,
  ) {}

  invalidate(): void {}

  private get count(): number {
    return this.choices.length + 1
  }

  /** The highlighted entry: a hand-off address, or undefined for none. */
  current(): { handoff?: string } {
    const c = this.choices[this.selected]
    return c ? { handoff: c.address } : {}
  }

  move(delta: number): void {
    this.selected = (this.selected + delta + this.count) % this.count
    if (this.selected < this.top) this.top = this.selected
    if (this.selected >= this.top + MAX_ROWS) this.top = this.selected - MAX_ROWS + 1
  }

  handleInput(data: string): void {
    if (this.kb.matches(data, "tui.select.up")) this.move(-1)
    else if (this.kb.matches(data, "tui.select.down")) this.move(1)
    else if (this.kb.matches(data, "tui.select.confirm")) this.finish(this.current())
    else if (this.kb.matches(data, "tui.select.cancel")) this.finish(null)
  }

  render(width: number): string[] {
    const t = this.theme
    const inner = Math.max(1, width - 4)
    const labels = [...this.choices.map(rowText), NONE_LABEL]
    const body = labels.slice(this.top, this.top + MAX_ROWS).map((label, i) => {
      const on = this.top + i === this.selected
      return on ? t.fg("accent", "> " + t.bold(label)) : "  " + t.fg("muted", label)
    })
    if (this.top > 0) body.unshift(t.fg("dim", `  ↑ ${this.top} more`))
    const below = labels.length - this.top - MAX_ROWS
    if (below > 0) body.push(t.fg("dim", `  ↓ ${below} more`))
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
