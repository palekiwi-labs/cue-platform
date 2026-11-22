import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  getSelectListTheme,
} from "@earendil-works/pi-coding-agent"
import { Editor, matchesKey } from "@earendil-works/pi-tui"
import { copyText } from "../turn-reader/chunks"
import { appendReply, replyText, TurnComments } from "../turn-reader/comments"
import { latestTurnKey, latestTurnTexts, type ReaderMessage } from "../turn-reader/latest-turn"
import {
  COMMENT_KEY,
  COPY_KEY,
  DELETE_KEY,
  FOCUS_KEY,
  MARGIN_Y,
  MODE_KEY,
  NEXT_COMMENT_KEY,
  PREV_COMMENT_KEY,
  readerWidth,
  REPLY_KEY,
  TurnReader,
} from "../turn-reader/reader"
import type { SpeakResult, Speech } from "../speech"

/** Open the latest turn reader. */
export const READER_SHORTCUT = "ctrl+u"
/** Reader key that speaks the focused chunk in focus mode, else the displayed text. */
export const READER_SPEAK_KEY = "s"

export type TurnSpeaker = Pick<Speech, "request">

export type SpeakNotes = Record<SpeakResult, [string, "info" | "warning"]>

/** Notifications for each speech request outcome, given what is spoken. */
export function speakNotes(subject: string): SpeakNotes {
  return {
    sent: [`Speaking ${subject}`, "info"],
    busy: ["Speech request refused while the agent is running", "warning"],
    unavailable: ["Speech is only available in the TUI", "warning"],
    empty: [`Nothing to speak in ${subject}`, "info"],
  }
}

const SPEAK_NOTES = speakNotes("the latest turn")
const SPEAK_CHUNK_NOTES = speakNotes("the focused chunk")

let live: ReaderMessage | undefined

const drafts = new Map<string, TurnComments>()

function turnComments(key: string | undefined): TurnComments {
  if (key === undefined) return new TurnComments()
  let comments = drafts.get(key)
  if (!comments) drafts.set(key, (comments = new TurnComments()))
  return comments
}

/**
 * Append the reply built from `comments` to the editor text. On success the
 * comments are cleared. Without comments nothing happens; on failure the
 * comments are kept. Both return false.
 */
export function insertReply(ctx: ExtensionContext, comments: TurnComments): boolean {
  const reply = replyText(comments)
  if (reply === "") return false
  const n = comments.size
  try {
    const text = appendReply(ctx.ui.getEditorText(), reply)
    ctx.ui.setEditorText(text)
    if (ctx.ui.getEditorText() !== text) throw new Error("the editor did not take the text")
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.ui.notify(`Could not insert comments (${reason}); drafts kept`, "error")
    return false
  }
  comments.clear()
  ctx.ui.notify(`Inserted ${n} comment${n === 1 ? "" : "s"} into the editor`, "info")
  return true
}

/** Writes text to the system clipboard; rejects when no clipboard route works. */
export type ClipboardWriter = (text: string) => Promise<void>

/**
 * Copy the focused chunk's source to the clipboard and report the outcome.
 * Resolves to the short outcome the reader shows in its footer.
 */
export async function copyChunk(ctx: ExtensionContext, text: string, copy: ClipboardWriter): Promise<string> {
  try {
    await copy(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.ui.notify(`Could not copy the focused chunk: ${reason}`, "error")
    return `copy failed: ${reason}`
  }
  ctx.ui.notify("Copied the focused chunk", "info")
  return "copied"
}

export async function openTurnReader(
  ctx: ExtensionContext,
  speaker?: TurnSpeaker,
  copy: ClipboardWriter = copyToClipboard,
): Promise<void> {
  if (!ctx.hasUI) return
  const branch = ctx.sessionManager.getBranch() as Parameters<typeof latestTurnTexts>[0]
  const messages = latestTurnTexts(branch, live)
  if (messages.length === 0) {
    ctx.ui.notify("No assistant text in the latest turn yet", "info")
    return
  }
  const running = !ctx.isIdle()
  const comments = turnComments(latestTurnKey(branch))
  await ctx.ui.custom<void>(
    (tui, theme, kb, done) => {
      const backdrop = tui.showOverlay(
        { render: (width) => Array(tui.terminal.rows).fill(" ".repeat(width)), invalidate: () => {} },
        { anchor: "top-left", width: "100%", maxHeight: "100%", nonCapturing: true },
      )
      const reader = new TurnReader(
        theme, getMarkdownTheme(), messages, () => tui.terminal.rows, running, !!speaker, comments,
      )
      const editorTheme = { borderColor: (s: string) => theme.fg("border", s), selectList: getSelectListTheme() }
      const close = () => {
        backdrop.hide()
        done()
      }
      return {
        render: (width) => reader.render(width),
        invalidate: () => reader.invalidate(),
        dispose: () => reader.cancelComment(),
        handleInput(data: string) {
          reader.clearFlash()
          if (reader.composing()) {
            if (kb.matches(data, "tui.select.cancel")) reader.cancelComment()
            else reader.composeInput(data)
          }
          else if (data === COMMENT_KEY) reader.comment(new Editor(tui, editorTheme))
          else if (data === DELETE_KEY) reader.deleteComment()
          else if (matchesKey(data, REPLY_KEY)) {
            if (insertReply(ctx, comments)) return close()
          }
          else if (matchesKey(data, PREV_COMMENT_KEY)) reader.jumpComment(-1)
          else if (matchesKey(data, NEXT_COMMENT_KEY)) reader.jumpComment(1)
          else if (kb.matches(data, "tui.select.up") || data === "k") reader.move(-1)
          else if (kb.matches(data, "tui.select.down") || data === "j") reader.move(1)
          else if (kb.matches(data, "tui.select.pageUp") || data === "b") reader.page(-1)
          else if (kb.matches(data, "tui.select.pageDown") || data === " ") reader.page(1)
          else if (matchesKey(data, "home") || data === "g") reader.top()
          else if (matchesKey(data, "end") || data === "G") reader.bottom()
          else if (data === MODE_KEY) reader.toggle()
          else if (data === FOCUS_KEY) reader.toggleFocus()
          else if (data === COPY_KEY) {
            const text = reader.focusedSource()
            if (text !== undefined) {
              void copyChunk(ctx, copyText(text), copy).then((flash) => {
                reader.showFlash(flash)
                tui.requestRender()
              })
            }
          }
          else if (speaker && data === READER_SPEAK_KEY) {
            const notes = reader.focused() ? SPEAK_CHUNK_NOTES : SPEAK_NOTES
            const [note, level] = notes[speaker.request(reader.spoken(), ctx)]
            ctx.ui.notify(note, level)
          }
          else if (kb.matches(data, "tui.select.cancel") || matchesKey(data, READER_SHORTCUT) || data === "q") {
            return close()
          }
          tui.requestRender()
        },
      }
    },
    {
      overlay: true,
      overlayOptions: () => ({
        anchor: "center",
        width: readerWidth(process.stdout.columns || 80),
        margin: { top: MARGIN_Y, bottom: MARGIN_Y },
      }),
    },
  )
}

export function registerTurnReader(pi: ExtensionAPI, speaker?: TurnSpeaker): void {
  pi.on("message_start", (event) => {
    live = event.message.role === "assistant" ? (event.message as ReaderMessage) : undefined
  })
  pi.on("message_update", (event) => {
    if (event.message.role === "assistant") live = event.message as ReaderMessage
  })
  pi.on("agent_end", () => {
    live = undefined
  })
  pi.registerCommand("cue:read", {
    description: "Read the assistant text of the latest turn",
    handler: async (_args, ctx) => openTurnReader(ctx, speaker),
  })
  pi.registerShortcut(READER_SHORTCUT, {
    description: "Read the latest turn",
    handler: async (ctx) => openTurnReader(ctx, speaker),
  })
}
