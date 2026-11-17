import { type Component, Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

/** Prose width the reader formats Markdown to, matching the editor's textwidth. */
export const TEXT_WIDTH = 80
/** Columns of blank space between the border and the text. */
export const PAD_X = 2
/** Terminal rows left free above and below the reader. */
export const MARGIN_Y = 1

const CHROME_X = 2 + 2 * PAD_X
const CHROME_Y = 4

interface ReaderTheme {
  fg(color: any, text: string): string
  bold(text: string): string
}

/** Overlay width for a terminal of `cols` columns: the text width plus chrome, capped. */
export function readerWidth(cols: number): number {
  return Math.max(CHROME_X + 1, Math.min(TEXT_WIDTH + CHROME_X, cols))
}

function trimBlank(lines: string[]): string[] {
  let a = 0
  let b = lines.length
  while (a < b && lines[a]!.trim() === "") a++
  while (b > a && lines[b - 1]!.trim() === "") b--
  return lines.slice(a, b)
}

/** Reader key that toggles between the last message and all messages. */
export const MODE_KEY = "a"

/**
 * Boxed, scrollable view of the latest turn's assistant messages, rendered as
 * Markdown and separated by a rule. Shows the last message until toggled to
 * all messages. Grows with the content up to the rows `rows()` reports, then
 * scrolls.
 */
export class TurnReader implements Component {
  private offset = 0
  private all = false
  private cache?: { width: number; all: boolean; lines: string[] }

  constructor(
    private theme: ReaderTheme,
    private markdown: MarkdownTheme,
    private messages: readonly string[],
    private rows: () => number,
    private running = false,
    private speakable = false,
  ) {}

  invalidate(): void {
    this.cache = undefined
  }

  /** The messages currently displayed. */
  shown(): readonly string[] {
    return this.all ? this.messages : this.messages.slice(-1)
  }

  /** Switch between the last message and all messages, if there is more than one. */
  toggle(): void {
    if (this.messages.length < 2) return
    this.all = !this.all
    this.offset = 0
  }

  private body(inner: number): string[] {
    if (this.cache?.width === inner && this.cache.all === this.all) return this.cache.lines
    const rule = this.theme.fg("dim", "---")
    const lines: string[] = []
    this.shown().forEach((text, i) => {
      if (i > 0) lines.push("", rule, "")
      lines.push(...trimBlank(new Markdown(text, 0, 0, this.markdown).render(inner)))
    })
    this.cache = { width: inner, all: this.all, lines }
    return lines
  }

  /** Rows available for the body. */
  viewport(): number {
    return Math.max(1, this.rows() - 2 * MARGIN_Y - CHROME_Y)
  }

  private maxOffset(): number {
    return Math.max(0, (this.cache?.lines.length ?? 0) - this.viewport())
  }

  scroll(delta: number): void {
    this.offset = Math.min(this.maxOffset(), Math.max(0, this.offset + delta))
  }

  page(direction: 1 | -1): void {
    this.scroll(direction * Math.max(1, this.viewport() - 1))
  }

  top(): void {
    this.offset = 0
  }

  bottom(): void {
    this.offset = this.maxOffset()
  }

  render(width: number): string[] {
    const t = this.theme
    const inner = Math.max(1, width - CHROME_X)
    const body = this.body(inner)
    const height = Math.min(body.length, this.viewport())
    this.offset = Math.min(this.offset, this.maxOffset())
    const shown = body.slice(this.offset, this.offset + height)

    const n = this.messages.length
    const mode = n === 1 ? "1 message" : this.all ? `all ${n} messages` : `last of ${n} messages`
    const head = ` latest turn · ${mode}${this.running ? " · snapshot" : ""} `
    const scrolls = body.length > height
    const position = scrolls ? `${this.offset + 1}-${this.offset + height}/${body.length} · ` : ""
    const toggle = n > 1 ? `${MODE_KEY} ${this.all ? "last" : "all"} · ` : ""
    const speak = this.speakable ? "s speak · " : ""
    const keys = toggle + speak + (scrolls ? "↑↓ pgup pgdn g G · esc" : "esc close")
    const foot = ` ${position}${keys} `

    const border = (s: string) => t.fg("border", s)
    const top = border("╭─") + t.fg("accent", t.bold(head)) +
      border("─".repeat(Math.max(0, width - 3 - visibleWidth(head))) + "╮")
    const bottom = border("╰" + "─".repeat(Math.max(0, width - 3 - visibleWidth(foot)))) +
      t.fg("dim", foot) + border("─╯")
    const pad = " ".repeat(PAD_X)
    const row = (s: string) => {
      const cut = truncateToWidth(s, inner, "…")
      return border("│") + pad + cut + " ".repeat(Math.max(0, inner - visibleWidth(cut))) + pad + border("│")
    }
    return [top, row(""), ...shown.map(row), row(""), bottom].map((l) => truncateToWidth(l, width))
  }
}
