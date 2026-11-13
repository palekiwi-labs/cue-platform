import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { missTrace, saveTranscript, writeMissTrace } from "../review-miss/report"

/**
 * Register `/review:miss [comment]`: file a review miss report with a
 * copy of the session transcript. A comment is required.
 */
export function registerReviewMissCommand(pi: ExtensionAPI): void {
  pi.registerCommand("review:miss", {
    description: "Report something the review pipeline missed, with the session transcript",
    handler: async (args, ctx) => {
      let comment = args.trim()
      while (!comment) {
        const answer = await ctx.ui.input("What did the review miss? (required, esc cancels)")
        if (answer === undefined) return
        comment = answer.trim()
      }
      const sessionFile = ctx.sessionManager.getSessionFile()
      try {
        const transcript = sessionFile ? await saveTranscript(sessionFile) : undefined
        const trace = missTrace({
          comment,
          cwd: ctx.cwd,
          date: new Date(),
          sessionFile,
          sessionId: ctx.sessionManager.getSessionId(),
          transcript,
        })
        await writeMissTrace(ctx.cwd, trace)
        ctx.ui.notify(`Review miss recorded: ${trace.filename}`, "info")
      } catch (err) {
        ctx.ui.notify(`review:miss failed: ${(err as Error).message}`, "error")
      }
    },
  })
}
