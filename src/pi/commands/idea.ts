import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { composeMessage, sendPrompt } from "./common"

export const IDEA_INSTRUCTIONS =
  "Load the `cue-idea` skill and follow it for the idea in `<idea>`."

/**
 * Register `/cue:idea <idea>`: capture the idea verbatim and hand off to
 * the cue-idea skill. Port of `commands/opencode/cue/idea.md`.
 */
export function registerIdeaCommand(pi: ExtensionAPI): void {
  pi.registerCommand("cue:idea", {
    description: "Capture an idea as an open cue note in the inbox context",
    handler: async (args, ctx) => {
      sendPrompt(
        pi,
        ctx,
        composeMessage([
          `<idea>\n${args}\n</idea>`,
          `PWD: ${ctx.cwd}`,
          IDEA_INSTRUCTIONS,
        ]),
      )
    },
  })
}
