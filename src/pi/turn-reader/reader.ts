import { type Component, Markdown, type MarkdownTheme, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { type SourceChunk, sourceChunks } from "./chunks"
import { chunkKey, TurnComments } from "./comments"

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

function sourceText(chunk: SourceChunk): string {
  if (chunk.indent === 0) return chunk.text
  const pad = " ".repeat(chunk.indent)
  return chunk.text.split("\n").map((l) => (l.trim() === "" ? l : pad + l)).join("\n")
}

function renderChunk(chunk: SourceChunk, inner: number, markdown: MarkdownTheme): string[] {
  const indent = Math.min(chunk.indent, Math.max(0, inner - 1))
  const pad = " ".repeat(indent)
  return trimBlank(new Markdown(chunk.text, 0, 0, markdown).render(inner - indent)).map((l) => pad + l)
}

/** Label above a comment in the reader. */
export const COMMENT_LABEL = "comment"
/** Gutter that marks comment rows. */
export const COMMENT_GUTTER = "┃ "

function plainText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "")
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
/** Reader key that composes or edits the comment on the focused chunk. */
export const COMMENT_KEY = "c"
/** Reader key that deletes the comment on the focused chunk. */
export const DELETE_KEY = "d"
/** Reader key that puts the quoted chunks and their comments into the editor. */
export const REPLY_KEY = "r"
/** Reader key that copies the focused chunk's source to the clipboard. */
export const COPY_KEY = "y"

/** The text editor the reader composes comments in. */
export interface CommentEditor {
  focused: boolean
  onSubmit?: (text: string) => void
  setText(text: string): void
  getExpandedText(): string
  handleInput(data: string): void
  render(width: number): string[]
}

interface Chunk {
  start: number
  end: number
  key: string
  quote: string
  text: string
}

interface Composer {
  editor: CommentEditor
  key: string
}

interface Body {
  width: number
  all: boolean
  version: number
  lines: string[]
  owner: number[]
  lead: string[]
  chunks: Chunk[]
}

/**
 * Boxed, scrollable view of the latest turn's assistant messages, rendered as
 * Markdown and separated by a rule. Shows the last message until toggled to
 * all messages. Grows with the content up to the rows `rows()` reports, then
 * scrolls. In focus mode the arrows step through chunks (blank-line separated
 * runs of source) and every chunk but the focused one is dimmed. Each chunk
 * may carry one draft comment, shown under it and composed in an editor at
 * the bottom of the reader.
 */
export class TurnReader implements Component {
  private offset = 0
  private all = false
  private focus = false
  private current = 0
  private cache?: Body
  private composer?: Composer
  private composeRows = 0
  private revealNext = false

  constructor(
    private theme: ReaderTheme,
    private markdown: MarkdownTheme,
    private messages: readonly string[],
    private rows: () => number,
    private running = false,
    private speakable = false,
    private comments = new TurnComments(),
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

  /** The texts to speak: the focused chunk's source in focus mode, else the messages displayed. */
  spoken(): readonly string[] {
    if (!this.focus) return this.shown()
    const text = this.focusedSource()
    return text === undefined ? [] : [text]
  }

  /** The focused chunk's Markdown source without its comment, or undefined when focus is off. */
  focusedSource(): string | undefined {
    if (!this.focus) return undefined
    const chunk = this.cache && this.body(this.cache.width).chunks[this.current]
    return chunk?.text
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
    const version = this.comments.version
    if (this.cache?.width === inner && this.cache.all === this.all && this.cache.version === version) return this.cache
    const rule = this.theme.fg("dim", "---")
    const body: Body = { width: inner, all: this.all, version, lines: [], owner: [], lead: [], chunks: [] }
    const base = this.messages.length - this.shown().length
    const mark = inner >= 6 ? COMMENT_GUTTER : COMMENT_GUTTER.trimEnd()
    const gutter = this.theme.fg("accent", mark)
    const label = gutter + this.theme.fg("accent", COMMENT_LABEL)
    const textWidth = Math.max(1, inner - visibleWidth(mark))
    const push = (line: string, chunk = -1, lead = "") => {
      body.lines.push(line)
      body.owner.push(chunk)
      body.lead.push(lead)
    }
    this.shown().forEach((text, i) => {
      if (i > 0) {
        push("")
        push(rule)
        push("")
      }
      let n = 0
      for (const chunk of sourceChunks(text)) {
        const lines = renderChunk(chunk, inner, this.markdown)
        if (lines.length === 0) continue
        if (n > 0) push("")
        const key = chunkKey(base + i, n++)
        const index = body.chunks.length
        const start = body.lines.length
        for (const line of lines) push(line, index)
        const comment = this.comments.get(key)
        if (comment) {
          push("", index)
          push(label, index, label)
          for (const line of plainText(comment.text).split("\n")) {
            for (const part of wrapTextWithAnsi(line, textWidth)) {
              push(gutter + (part === "" ? "" : this.theme.fg("muted", part)), index, gutter)
            }
          }
        }
        body.chunks.push({ start, end: body.lines.length - 1, key, quote: sourceText(chunk), text: chunk.text })
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
    return Math.max(1, readerHeight(this.rows()) - BORDER_Y - 2 * this.padY() - this.composeRows)
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
    this.reveal()
  }

  private reveal(): void {
    const chunk = this.cache?.chunks[this.current]
    if (!chunk) return
    const { start, end } = chunk
    const view = this.viewport()
    if (end - start + 1 >= view || start < this.offset) this.offset = start
    else if (end >= this.offset + view) this.offset = end - view + 1
    this.scroll(0)
  }

  /** Whether a comment is being composed. */
  composing(): boolean {
    return this.composer !== undefined
  }

  /**
   * Compose the comment on the focused chunk in `editor`, turning focus on
   * first if needed. The editor starts from the last unsaved text on the
   * chunk, else its saved comment. Submitting saves; empty text deletes.
   */
  comment(editor: CommentEditor): boolean {
    if (!this.focus) this.toggleFocus()
    const chunk = this.cache?.chunks[this.current]
    if (!chunk) return false
    const { key, quote } = chunk
    editor.setText(this.comments.draft(key))
    editor.focused = true
    editor.onSubmit = (text) => {
      this.comments.save(key, quote, text)
      editor.focused = false
      this.composer = undefined
      this.composeRows = 0
      this.revealNext = true
    }
    this.composer = { editor, key }
    return true
  }

  /** Forward input to the comment editor. */
  composeInput(data: string): void {
    this.composer?.editor.handleInput(data)
  }

  /** Stop composing without saving, keeping the unsaved text for the next compose. */
  cancelComment(): void {
    if (!this.composer) return
    const { editor, key } = this.composer
    this.comments.discard(key, editor.getExpandedText())
    editor.focused = false
    this.composer = undefined
    this.composeRows = 0
  }

  /** Delete the comment on the focused chunk. */
  deleteComment(): void {
    const chunk = this.focus ? this.cache?.chunks[this.current] : undefined
    if (chunk) this.comments.remove(chunk.key)
  }

  private focusedComment(): boolean {
    const chunk = this.focus ? this.cache?.chunks[this.current] : undefined
    return chunk !== undefined && this.comments.get(chunk.key) !== undefined
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
    const { lines: body, owner, lead, chunks } = this.body(inner)
    const editor = this.composer?.editor.render(inner) ?? []
    this.composeRows = editor.length
    if (this.composer || this.revealNext) this.reveal()
    this.revealNext = false
    const height = Math.min(body.length, this.viewport())
    this.offset = Math.min(this.offset, this.maxOffset())
    const shown = body.slice(this.offset, this.offset + height)

    const n = this.messages.length
    const mode = n === 1 ? "1 message" : this.all ? `all ${n} messages` : `last of ${n} messages`
    const chunk = this.focus && chunks.length > 0 ? ` · chunk ${this.current + 1}/${chunks.length}` : ""
    const count = this.comments.size
    const notes = count > 0 ? ` · ${count} comment${count === 1 ? "" : "s"}` : ""
    const head = ` latest turn · ${mode}${chunk}${notes}${this.running ? " · snapshot" : ""} `
    const scrolls = body.length > height
    const foot = this.footer(width, scrolls ? `${this.offset + 1}-${this.offset + height}/${body.length}` : "")

    const border = (s: string) => t.fg("borderMuted", s)
    const top = border("╭─") + t.fg("accent", t.bold(head)) +
      border("─".repeat(Math.max(0, width - 3 - visibleWidth(head))) + "╮")
    const bottom = border("╰" + "─".repeat(Math.max(0, width - 3 - visibleWidth(foot)))) +
      t.fg("dim", foot) + border("─╯")
    const pad = " ".repeat(PAD_X)
    const row = (s: string, dim = false, keep = "") => {
      const cut = truncateToWidth(s, inner, "…")
      const fill = " ".repeat(Math.max(0, inner - visibleWidth(cut)))
      const kept = keep !== "" && cut.startsWith(keep)
      const text = !dim ? cut : kept ? keep + (cut.length > keep.length ? faint(cut.slice(keep.length)) : "") : faint(cut)
      return border("│") + pad + text + fill + pad + border("│")
    }
    const dimmed = (i: number) =>
      this.focus && owner[i] !== this.current && body[i]!.trim() !== "" && body[i] !== lead[i]
    const rows = shown.map((line, i) => row(line, dimmed(this.offset + i), lead[this.offset + i]))
    const composed = editor.map((line) => border("│") + pad + line + pad + border("│"))
    const blank = Array(this.padY()).fill(row(""))
    return [top, ...blank, ...rows, ...composed, ...blank, bottom].map((l) => truncateToWidth(l, width))
  }

  private footer(width: number, position: string): string {
    const n = this.messages.length
    const scrolls = position !== ""
    const hints: [string, number][] = this.composer
      ? [["enter save", 9], ["alt+enter newline", 1], ["esc cancel", 9]]
      : [
          [position, 2],
          [n > 1 ? `${MODE_KEY} ${this.all ? "last" : "all"}` : "", 4],
          [this.speakable ? (this.focus ? "s speak chunk" : "s speak") : "", 3],
          [`${FOCUS_KEY} ${this.focus ? "unfocus" : "focus"}`, 9],
          [this.focus ? `${COPY_KEY} copy` : "", 1],
          [this.focus ? `${COMMENT_KEY} comment` : "", 9],
          [this.focusedComment() ? `${DELETE_KEY} delete` : "", 9],
          [this.comments.size > 0 ? `${REPLY_KEY} reply` : "", 9],
          [this.focus ? "↑↓ chunk" : scrolls ? "↑↓" : "", 5],
          [scrolls ? "pgup pgdn g G" : "", 1],
          [this.focus || scrolls ? "esc" : "esc close", 6],
        ]
    let foot = ""
    for (let drop = 0; drop < 9; drop++) {
      foot = ` ${hints.filter(([h, keep]) => h !== "" && keep > drop).map(([h]) => h).join(" · ")} `
      if (visibleWidth(foot) <= width - 4) break
    }
    return foot
  }
}
