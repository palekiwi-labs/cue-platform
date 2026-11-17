import { type Component, Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { type SourceChunk, sourceChunks } from "./chunks"

/** Prose width the reader formats Markdown to, matching the editor's textwidth. */
export const TEXT_WIDTH = 80
/** Columns of blank space between the border and the text. */
export const PAD_X = 2
/** Terminal rows left free above and below the reader. */
export const MARGIN_Y = 1
/** Share of the terminal height the reader may take. */
export const MAX_HEIGHT = 0.75

const CHROME_X = 2 + 2 * PAD_X
const BORDER_Y = 2

interface ReaderTheme {
  fg(color: any, text: string): string
  bold(text: string): string
}

/** Overlay width for a terminal of `cols` columns: the text width plus chrome, capped. */
export function readerWidth(cols: number): number {
  return Math.max(CHROME_X + 1, Math.min(TEXT_WIDTH + CHROME_X, cols))
}

/** Rows the whole reader may take on a terminal of `rows` rows, borders included. */
export function readerHeight(rows: number): number {
  return Math.max(BORDER_Y + 1, Math.min(Math.floor(rows * MAX_HEIGHT), rows - 2 * MARGIN_Y))
}

function trimBlank(lines: string[]): string[] {
  let a = 0
  let b = lines.length
  while (a < b && lines[a]!.trim() === "") a++
  while (b > a && lines[b - 1]!.trim() === "") b--
  return lines.slice(a, b)
}

function renderChunk(chunk: SourceChunk, inner: number, markdown: MarkdownTheme): string[] {
  const indent = Math.min(chunk.indent, Math.max(0, inner - 1))
  const pad = " ".repeat(indent)
  return trimBlank(new Markdown(chunk.text, 0, 0, markdown).render(inner - indent)).map((l) => pad + l)
}

const FAINT = "\x1b[2m"
const NORMAL = "\x1b[22m"

/** `line` in the faint attribute, kept faint across the styles it contains. */
export function faint(line: string): string {
  return FAINT + line.replace(/\x1b\[[0-9;]*m/g, (sgr) => sgr + FAINT) + NORMAL
}

/** Reader key that toggles between the last message and all messages. */
export const MODE_KEY = "a"
/** Reader key that toggles chunk focus. */
export const FOCUS_KEY = "f"

interface Chunk {
  start: number
  end: number
}

interface Body {
  width: number
  all: boolean
  lines: string[]
  owner: number[]
  chunks: Chunk[]
}

/**
 * Boxed, scrollable view of the latest turn's assistant messages, rendered as
 * Markdown and separated by a rule. Shows the last message until toggled to
 * all messages. Grows with the content up to the rows `rows()` reports, then
 * scrolls. In focus mode the arrows step through chunks (blank-line separated
 * runs of source) and every chunk but the focused one is dimmed.
 */
export class TurnReader implements Component {
  private offset = 0
  private all = false
  private focus = false
  private current = 0
  private cache?: Body

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
    this.current = 0
  }

  /** Whether chunk focus is on. */
  focused(): boolean {
    return this.focus
  }

  /** Toggle chunk focus; turning it on focuses the first chunk in view. */
  toggleFocus(): void {
    this.focus = !this.focus
    if (!this.focus) return
    const chunks = this.cache?.chunks ?? []
    const next = chunks.findIndex((c) => c.end >= this.offset)
    this.current = next < 0 ? Math.max(0, chunks.length - 1) : next
  }

  private body(inner: number): Body {
    if (this.cache?.width === inner && this.cache.all === this.all) return this.cache
    const rule = this.theme.fg("dim", "---")
    const body: Body = { width: inner, all: this.all, lines: [], owner: [], chunks: [] }
    const push = (line: string, chunk = -1) => {
      body.lines.push(line)
      body.owner.push(chunk)
    }
    this.shown().forEach((text, i) => {
      if (i > 0) {
        push("")
        push(rule)
        push("")
      }
      let first = true
      for (const chunk of sourceChunks(text)) {
        const lines = renderChunk(chunk, inner, this.markdown)
        if (lines.length === 0) continue
        if (!first) push("")
        first = false
        const index = body.chunks.length
        body.chunks.push({ start: body.lines.length, end: body.lines.length + lines.length - 1 })
        for (const line of lines) push(line, index)
      }
    })
    this.current = Math.min(this.current, Math.max(0, body.chunks.length - 1))
    this.cache = body
    return body
  }

  private padY(): number {
    return readerHeight(this.rows()) > BORDER_Y + 2 ? 1 : 0
  }

  /** Rows available for the body. */
  viewport(): number {
    return Math.max(1, readerHeight(this.rows()) - BORDER_Y - 2 * this.padY())
  }

  private maxOffset(): number {
    return Math.max(0, (this.cache?.lines.length ?? 0) - this.viewport())
  }

  scroll(delta: number): void {
    this.offset = Math.min(this.maxOffset(), Math.max(0, this.offset + delta))
  }

  /** Step one chunk in focus mode, otherwise scroll one line. */
  move(direction: 1 | -1): void {
    if (this.focus) this.step(direction)
    else this.scroll(direction)
  }

  /** Focus the neighbouring chunk and scroll it into view. */
  step(direction: 1 | -1): void {
    const chunks = this.cache?.chunks ?? []
    if (chunks.length === 0) return
    this.current = Math.min(chunks.length - 1, Math.max(0, this.current + direction))
    const { start, end } = chunks[this.current]!
    const view = this.viewport()
    if (end - start + 1 >= view || start < this.offset) this.offset = start
    else if (end >= this.offset + view) this.offset = end - view + 1
    this.scroll(0)
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
    const { lines: body, owner, chunks } = this.body(inner)
    const height = Math.min(body.length, this.viewport())
    this.offset = Math.min(this.offset, this.maxOffset())
    const shown = body.slice(this.offset, this.offset + height)

    const n = this.messages.length
    const mode = n === 1 ? "1 message" : this.all ? `all ${n} messages` : `last of ${n} messages`
    const chunk = this.focus && chunks.length > 0 ? ` · chunk ${this.current + 1}/${chunks.length}` : ""
    const head = ` latest turn · ${mode}${chunk}${this.running ? " · snapshot" : ""} `
    const scrolls = body.length > height
    const position = scrolls ? `${this.offset + 1}-${this.offset + height}/${body.length} · ` : ""
    const toggle = n > 1 ? `${MODE_KEY} ${this.all ? "last" : "all"} · ` : ""
    const speak = this.speakable ? "s speak · " : ""
    const focus = `${FOCUS_KEY} ${this.focus ? "unfocus" : "focus"} · `
    const nav = this.focus
      ? (scrolls ? "↑↓ chunk · pgup pgdn g G · esc" : "↑↓ chunk · esc")
      : (scrolls ? "↑↓ pgup pgdn g G · esc" : "esc close")
    const keys = toggle + speak + focus + nav
    const foot = ` ${position}${keys} `

    const border = (s: string) => t.fg("borderMuted", s)
    const top = border("╭─") + t.fg("accent", t.bold(head)) +
      border("─".repeat(Math.max(0, width - 3 - visibleWidth(head))) + "╮")
    const bottom = border("╰" + "─".repeat(Math.max(0, width - 3 - visibleWidth(foot)))) +
      t.fg("dim", foot) + border("─╯")
    const pad = " ".repeat(PAD_X)
    const row = (s: string, dim = false) => {
      const cut = truncateToWidth(s, inner, "…")
      const fill = " ".repeat(Math.max(0, inner - visibleWidth(cut)))
      return border("│") + pad + (dim ? faint(cut) : cut) + fill + pad + border("│")
    }
    const dimmed = (i: number) => this.focus && owner[i] !== this.current && body[i]!.trim() !== ""
    const rows = shown.map((line, i) => row(line, dimmed(this.offset + i)))
    const blank = Array(this.padY()).fill(row(""))
    return [top, ...blank, ...rows, ...blank, bottom].map((l) => truncateToWidth(l, width))
  }
}
