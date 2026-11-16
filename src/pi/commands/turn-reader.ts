import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent"
import { matchesKey } from "@earendil-works/pi-tui"
import { latestTurnTexts, type ReaderMessage } from "../turn-reader/latest-turn"
import { MARGIN_Y, readerWidth, TurnReader } from "../turn-reader/reader"

/** Open the latest turn reader. */
export const READER_SHORTCUT = "f5"

let live: ReaderMessage | undefined

export async function openTurnReader(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return
  const branch = ctx.sessionManager.getBranch() as Parameters<typeof latestTurnTexts>[0]
  const messages = latestTurnTexts(branch, live)
  if (messages.length === 0) {
    ctx.ui.notify("No assistant text in the latest turn yet", "info")
    return
  }
  const running = !ctx.isIdle()
  await ctx.ui.custom<void>(
    (tui, theme, kb, done) => {
      const backdrop = tui.showOverlay(
        { render: (width) => Array(tui.terminal.rows).fill(" ".repeat(width)), invalidate: () => {} },
        { anchor: "top-left", width: "100%", maxHeight: "100%", nonCapturing: true },
      )
      const reader = new TurnReader(theme, getMarkdownTheme(), messages, () => tui.terminal.rows, running)
      const close = () => {
        backdrop.hide()
        done()
      }
      return {
        render: (width) => reader.render(width),
        invalidate: () => reader.invalidate(),
        handleInput(data: string) {
          if (kb.matches(data, "tui.select.up") || data === "k") reader.scroll(-1)
          else if (kb.matches(data, "tui.select.down") || data === "j") reader.scroll(1)
          else if (kb.matches(data, "tui.select.pageUp") || data === "b") reader.page(-1)
          else if (kb.matches(data, "tui.select.pageDown") || data === " ") reader.page(1)
          else if (matchesKey(data, "home") || data === "g") reader.top()
          else if (matchesKey(data, "end") || data === "G") reader.bottom()
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

export function registerTurnReader(pi: ExtensionAPI): void {
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
    handler: async (_args, ctx) => openTurnReader(ctx),
  })
  pi.registerShortcut(READER_SHORTCUT, {
    description: "Read the latest turn",
    handler: async (ctx) => openTurnReader(ctx),
  })
}
