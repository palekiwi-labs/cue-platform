import { copyToClipboard, type ExtensionAPI, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent"
import { type Component, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { autoSummary } from "../turn-summary/settings"
import { feedbackNote, writeFeedbackNote } from "../turn-summary/feedback"
import { SUMMARIZER_ENV, summarizerPrompt, summarizeTurn } from "../turn-summary/summarize"
import { storedSummaries, TURN_SUMMARY_TYPE, type Turn, type TurnSummaryData, turnsOf } from "../turn-summary/turns"
import { speakNotes, type TurnSpeaker } from "./turn-reader"
import type { SpeechProgress } from "../speech/nats-sender"

/** Open the turn summary popup. */
export const SUMMARY_SHORTCUT = "alt+u"
/** Summary popup key that speaks the shown summary. */
export const SUMMARY_SPEAK_KEY = "s"

const SPEAK_NOTES = speakNotes("the turn summary")

function footer(speakable: boolean): string {
  const speak = speakable ? " • s speak" : ""
  return `← → turns${speak} • ctrl+y copy • ctrl+r report • esc close`
}
const PAD_X = 3
const MAX_WIDTH = 86

const pending = new Map<string, Promise<TurnSummaryData>>()

/** Summarize a turn once: concurrent requests for the same turn share one run. */
function ensureSummary(pi: ExtensionAPI, turn: Turn, cwd: string): Promise<TurnSummaryData> {
  let p = pending.get(turn.id)
  if (!p) {
    p = summarizeTurn(turn.prompt, turn.text, cwd).then((run) => {
      const data: TurnSummaryData = { turnId: turn.id, ...run }
      pi.appendEntry(TURN_SUMMARY_TYPE, data)
      return data
    })
    p.catch(() => {}).finally(() => pending.delete(turn.id))
    pending.set(turn.id, p)
  }
  return p
}

type Reported = { turn: Turn; summary: TurnSummaryData }

type Slot = { state: "ready"; data: TurnSummaryData } | { state: "loading" } | { state: "error"; text: string }

export interface WrappedLine {
  text: string
  start: number
  end: number
}

/** Greedy word wrap of plain text, each visual line with its source offsets. */
export function wrapLines(text: string, width: number): WrappedLine[] {
  const out: WrappedLine[] = []
  if (width < 1) return out
  let pos = 0
  for (const para of text.split("\n")) {
    if (para === "") {
      out.push({ text: "", start: pos, end: pos + 1 })
      pos += 1
      continue
    }
    let start = pos
    let line = ""
    for (const word of para.split(" ")) {
      const next = line === "" ? word : line + " " + word
      if (line !== "" && next.length > width) {
        out.push({ text: line, start, end: start + line.length })
        start += line.length + 1
        line = word
      } else {
        line = next
      }
    }
    out.push({ text: line, start, end: start + line.length })
    pos += para.length + 1
  }
  return out
}

/** Rows of body the popup may show: terminal height minus chrome and margin. */
function bodyRows(rows: number): number {
  return Math.max(1, rows - 8)
}

class SummaryPopup implements Component {
  private index: number
  private slots = new Map<string, Slot>()
  private flash = ""
  private active: [number, number] | null = null
  private scroll = 0
  private closed = false

  constructor(
    private pi: ExtensionAPI,
    private cwd: string,
    private tui: TUI,
    private theme: Theme,
    private turns: Turn[],
    stored: Map<string, TurnSummaryData>,
    private speak?: (text: string, onProgress: (event: SpeechProgress) => void) => void,
  ) {
    this.index = turns.length - 1
    for (const [id, data] of stored) this.slots.set(id, { state: "ready", data })
    this.load()
  }

  invalidate(): void {}

  close(): void {
    this.closed = true
    this.active = null
  }

  clearFlash(): void {
    this.flash = ""
  }

  move(delta: number): void {
    const next = Math.min(this.turns.length - 1, Math.max(0, this.index + delta))
    if (next === this.index) return
    this.index = next
    this.active = null
    this.scroll = 0
    this.load()
  }

  speakCurrent(): void {
    const r = this.current()
    if (r && this.speak) this.speak(r.summary.text, (event) => this.onProgress(event))
  }

  private onProgress(event: SpeechProgress): void {
    if (this.closed) return
    const summary = this.slots.get(this.turns[this.index]!.id)
    if (summary?.state !== "ready") return
    if (event.type === "chunk" && event.text) {
      const from = this.active?.[1] ?? 0
      const at = summary.data.text.indexOf(event.text, from)
      const start = at >= 0 ? at : summary.data.text.indexOf(event.text)
      if (start >= 0) this.active = [start, start + event.text.length]
    } else {
      this.active = null
      this.scroll = 0
    }
    this.tui.requestRender()
  }

  copy(): void {
    const slot = this.slots.get(this.turns[this.index]!.id)
    if (slot?.state !== "ready") return
    copyToClipboard(slot.data.text).then(
      () => (this.flash = "copied"),
      (err) => (this.flash = `copy failed: ${(err as Error).message}`),
    ).finally(() => this.tui.requestRender())
  }

  /** The shown turn and its summary, once the summary is ready. */
  current(): Reported | undefined {
    const turn = this.turns[this.index]!
    const slot = this.slots.get(turn.id)
    return slot?.state === "ready" ? { turn, summary: slot.data } : undefined
  }

  private load(): void {
    const turn = this.turns[this.index]
    if (!turn || this.slots.get(turn.id)?.state === "ready") return
    if (this.slots.get(turn.id)?.state === "loading") return
    this.slots.set(turn.id, { state: "loading" })
    ensureSummary(this.pi, turn, this.cwd).then(
      (data) => this.slots.set(turn.id, { state: "ready", data }),
      (err) => this.slots.set(turn.id, { state: "error", text: (err as Error).message ?? String(err) }),
    ).finally(() => this.tui.requestRender())
  }

  render(width: number): string[] {
    const t = this.theme
    const inner = Math.max(1, width - 2 - 2 * PAD_X)
    const turn = this.turns[this.index]!
    const slot = this.slots.get(turn.id)
    const head = ` turn ${this.index + 1}/${this.turns.length} `
    const prompt = t.fg("dim", truncateToWidth(turn.prompt.replace(/\s+/g, " "), inner, "…"))
    let body: string[]
    if (slot?.state === "ready") {
      const wrapped = wrapLines(slot.data.text, inner)
      const avail = bodyRows(this.tui.terminal.rows)
      if (this.active) {
        const [aStart, aEnd] = this.active
        const first = wrapped.findIndex((l) => l.start < aEnd && l.end > aStart)
        if (first >= 0) {
          if (first < this.scroll) this.scroll = first
          else if (first >= this.scroll + avail) this.scroll = first - avail + 1
        }
        const last = this.scroll + avail
        body = wrapped.slice(this.scroll, last).map((l, i) => {
          const lit = l.start < aEnd && l.end > aStart
          const line = lit ? t.fg("accent", t.bold(l.text)) : t.fg("dim", l.text)
          return line + (i === avail - 1 && last < wrapped.length ? " ↓" : "")
        })
      } else {
        this.scroll = 0
        body = wrapped.slice(0, avail).map((l) => l.text)
        if (wrapped.length > avail) body[avail - 1] = (body[avail - 1] ?? "") + " ↓"
      }
    } else if (slot?.state === "error") {
      body = wrapTextWithAnsi(t.fg("error", `summary failed: ${slot.text}`), inner)
    } else {
      body = [t.fg("dim", "summarizing…")]
    }
    const border = (s: string) => t.fg("border", s)
    const foot = ` ${this.flash || footer(!!this.speak)} `
    const top = border("╭─") + t.fg("accent", t.bold(head)) +
      border("─".repeat(Math.max(0, width - 3 - visibleWidth(head))) + "╮")
    const bottom = border("╰" + "─".repeat(Math.max(0, width - 3 - visibleWidth(foot)))) +
      t.fg("dim", foot) + border("─╯")
    const row = (s: string) => {
      const cut = truncateToWidth(s, inner, "…")
      const pad = " ".repeat(PAD_X)
      return border("│") + pad + cut + " ".repeat(Math.max(0, inner - visibleWidth(cut))) + pad + border("│")
    }
    return [top, row(""), row(prompt), row(""), ...body.map(row), row(""), bottom].map((l) => truncateToWidth(l, width))
  }
}

function popupWidth(): number {
  const cols = process.stdout.columns || 80
  return Math.min(Math.floor(cols * 0.7), MAX_WIDTH)
}

function popupComponent(
  popup: SummaryPopup,
  tui: TUI,
  kb: KeybindingsManager,
  done: (r?: Reported) => void,
): Component {
  return {
    render: (width) => popup.render(width),
    invalidate: () => popup.invalidate(),
    handleInput(data: string) {
      popup.clearFlash()
      if (matchesKey(data, SUMMARY_SPEAK_KEY)) popup.speakCurrent()
      else if (matchesKey(data, "ctrl+y")) popup.copy()
      else if (matchesKey(data, "ctrl+r")) {
        const r = popup.current()
        if (r) return done(r)
      }
      else if (matchesKey(data, "left") || data === "h") popup.move(-1)
      else if (matchesKey(data, "right") || data === "l") popup.move(1)
      else if (kb.matches(data, "tui.select.cancel") || matchesKey(data, SUMMARY_SHORTCUT) || data === "q") {
        return done()
      }
      tui.requestRender()
    },
  }
}

export async function openTurnSummary(pi: ExtensionAPI, ctx: ExtensionContext, speaker?: TurnSpeaker): Promise<void> {
  if (!ctx.hasUI) return
  const branch = ctx.sessionManager.getBranch() as Parameters<typeof turnsOf>[0]
  const turns = turnsOf(branch)
  if (turns.length === 0) {
    ctx.ui.notify("No turn to summarize yet", "info")
    return
  }
  const stored = storedSummaries(branch)
  const reported = await ctx.ui.custom<Reported | undefined>(
    (tui, theme, kb, done) => {
      const backdrop = tui.showOverlay(
        { render: (width) => Array(tui.terminal.rows).fill(" ".repeat(width)), invalidate: () => {} },
        { anchor: "top-left", width: "100%", maxHeight: "100%", nonCapturing: true },
      )
      const speak = speaker
        ? (text: string, onProgress: (event: SpeechProgress) => void) => {
            const [note, level] = SPEAK_NOTES[speaker.request([text], ctx, onProgress)]
            ctx.ui.notify(note, level)
          }
        : undefined
      const popup = new SummaryPopup(pi, ctx.cwd, tui, theme, turns, stored, speak)
      return popupComponent(popup, tui, kb, (r) => {
        popup.close()
        backdrop.hide()
        done(r)
      })
    },
    { overlay: true, overlayOptions: () => ({ anchor: "center", width: popupWidth() }) },
  )
  if (reported) await reportSummary(ctx, reported)
}

/** Ask what is wrong with a summary and file it as a feedback note; a comment is required. */
async function reportSummary(ctx: ExtensionContext, { turn, summary }: Reported): Promise<void> {
  let comment: string | undefined
  while (!comment) {
    const answer = await ctx.ui.input("What's wrong with this summary? (required, esc cancels)")
    if (answer === undefined) return
    comment = answer.trim()
  }
  const note = feedbackNote({
    comment,
    summary,
    input: summarizerPrompt(turn.prompt, turn.text),
    sessionFile: ctx.sessionManager.getSessionFile(),
    cwd: ctx.cwd,
    date: new Date(),
  })
  try {
    await writeFeedbackNote(note)
    ctx.ui.notify(`Reported: ${note.filename}`, "info")
  } catch (err) {
    ctx.ui.notify(`report failed: ${(err as Error).message}`, "error")
  }
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

export function registerTurnSummary(pi: ExtensionAPI, speaker?: TurnSpeaker): void {
  pi.on("agent_end", (_event, ctx) => {
    if (ctx.hasUI && !process.env[SUMMARIZER_ENV] && autoSummary()) summarizeLastTurn(pi, ctx)
  })
  pi.registerCommand("cue:summary", {
    description: "Show a short summary of the last turn and browse earlier ones",
    handler: async (_args, ctx) => openTurnSummary(pi, ctx, speaker),
  })
  pi.registerShortcut(SUMMARY_SHORTCUT, {
    description: "Show turn summaries",
    handler: async (ctx) => openTurnSummary(pi, ctx, speaker),
  })
}
