import type { KeybindingsManager } from "@earendil-works/pi-coding-agent"
import { type Component, type KeyId, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

/** Opens the settings form inside a view. */
export const SETTINGS_KEY: KeyId = "f4"

export type SettingGroup = "filter" | "display"

export const SETTING_GROUPS: SettingGroup[] = ["filter", "display"]

/** One row of the settings form: a named value picked from a fixed list. */
export interface Setting {
  label: string
  group: SettingGroup
  values: string[]
  /** Index of the current value in values. */
  current: number
  /** Make values[index] the view's value; called only when it changed. */
  apply: (index: number) => void
}

const FOOTER = "enter apply • esc cancel"

interface FormTheme {
  fg(color: any, text: string): string
  bold(text: string): string
}

/** Settings in group order, as the form lists them. */
export function orderedSettings(settings: Setting[]): Setting[] {
  return SETTING_GROUPS.flatMap((g) => settings.filter((s) => s.group === g))
}

const labelWidth = (settings: Setting[]) => Math.max(0, ...settings.map((s) => visibleWidth(s.label)))
const valueWidth = (settings: Setting[]) =>
  Math.max(0, ...settings.flatMap((s) => s.values.map((v) => visibleWidth(v))))

/** Width of the boxed form for these settings. */
export function settingsWidth(settings: Setting[], title: string): number {
  const body = 2 + labelWidth(settings) + 3 + valueWidth(settings) + 4
  return Math.max(body, visibleWidth(title) + 2, visibleWidth(FOOTER) + 2) + 4
}

/**
 * Boxed form of settings: up/down pick a row, left/right change its
 * value, enter applies every changed value, esc discards them.
 */
export class SettingsForm implements Component {
  row = 0
  readonly picked: number[]
  private rows: Setting[]

  constructor(
    private theme: FormTheme,
    private kb: KeybindingsManager,
    private title: string,
    settings: Setting[],
    private finish: (applied: boolean) => void,
  ) {
    this.rows = orderedSettings(settings)
    this.picked = this.rows.map((s) => s.current)
  }

  invalidate(): void {}

  moveRow(delta: number): void {
    const n = this.rows.length
    if (n > 0) this.row = (this.row + delta + n) % n
  }

  step(delta: number): void {
    const s = this.rows[this.row]
    if (!s) return
    const n = s.values.length
    this.picked[this.row] = (this.picked[this.row]! + delta + n) % n
  }

  /** Apply every changed value in form order. */
  apply(): void {
    this.rows.forEach((s, i) => {
      if (this.picked[i] !== s.current) s.apply(this.picked[i]!)
    })
  }

  handleInput(data: string): void {
    if (this.kb.matches(data, "tui.select.up")) this.moveRow(-1)
    else if (this.kb.matches(data, "tui.select.down")) this.moveRow(1)
    else if (matchesKey(data, "left")) this.step(-1)
    else if (matchesKey(data, "right")) this.step(1)
    else if (this.kb.matches(data, "tui.select.confirm")) {
      this.apply()
      this.finish(true)
    } else if (this.kb.matches(data, "tui.select.cancel") || matchesKey(data, SETTINGS_KEY)) this.finish(false)
  }

  render(width: number): string[] {
    const t = this.theme
    const inner = Math.max(1, width - 4)
    const lw = labelWidth(this.rows)
    const body: string[] = []
    let group: SettingGroup | undefined
    this.rows.forEach((s, i) => {
      if (s.group !== group) {
        if (group) body.push("")
        group = s.group
        body.push(t.fg("accent", group))
      }
      const on = i === this.row
      const label = s.label.padEnd(lw)
      const value = `< ${s.values[this.picked[i]!] ?? ""} >`
      body.push(on
        ? t.fg("accent", "> " + t.bold(label)) + "   " + t.fg("accent", value)
        : "  " + t.fg("muted", label) + "   " + value)
    })
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
