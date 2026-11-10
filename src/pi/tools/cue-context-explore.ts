import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { exploreContext, parseDetail } from "../lib/context-explore"

const parameters = Type.Object({
  address: Type.String({
    description:
      "Canonical context address <org>/<repo>/<context>, any scope. For an " +
      "artifact address, pass its context (the first three segments) and " +
      "read the artifact itself.",
  }),
  detail: Type.Optional(
    Type.Union(
      [Type.Literal("identity"), Type.Literal("brief"), Type.Literal("working")],
      {
        description:
          "Cumulative levels. identity: locate the context and see its links. " +
          "brief (default): decide whether it is relevant and catch up. " +
          "working: only when this session works in the context; prints its " +
          "spec, plans and hand-off in full.",
      },
    ),
  ),
})

export function cueContextExploreTool(pi: ExtensionAPI): ToolDefinition<typeof parameters> {
  return {
    name: "cue-context-explore",
    label: "cue context explore",
    description:
      "Read one cue context at a chosen detail, to catch up on a context " +
      "the operator mentions instead of browsing the store. Parent, " +
      "children and refs are listed with titles and activity counts, never " +
      "expanded: explore a linked context with another call. Read-only; it " +
      "does not link the session, and the context's own instructions do " +
      "not apply unless the session works in it.",
    parameters,
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      const text = await exploreContext(pi, ctx.cwd, args.address, parseDetail(args.detail))
      return { content: [{ type: "text", text }], details: {} }
    },
  }
}
