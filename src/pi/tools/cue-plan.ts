import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { contextFlag, dirFlag, storeFlag } from "../lib/cue-args"
import { runCue } from "../lib/cue-exec"
import { frontmatterFlags } from "../lib/frontmatter"
import { withTempFile } from "../lib/temp"

const parameters = Type.Object({
  filename: Type.String({
    description:
      "Name of the file (e.g. 'lane-a-bridge.md'). Must not contain path separators.",
  }),
  content: Type.String({ description: "Full content of the artifact" }),
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("open"),
        Type.Literal("in-progress"),
        Type.Literal("complete"),
        Type.Literal("closed"),
      ],
      { description: "Status of the plan. Default: open." },
    ),
  ),
  parent: Type.Optional(
    Type.String({
      description:
        "Canonical address of the goal this plan serves, normally a task " +
        "(e.g. 'palekiwi/palekiwi/cue-review/task/scaffold-crate.md'). " +
        "Omit only for a context-level master plan, where the context has " +
        "one overriding goal.",
    }),
  ),
  refs: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Canonical addresses (<scope>/<context>/<type>/<name>) this plan " +
        "links to. Emitted as a `refs:` YAML list.",
    }),
  ),
  context: Type.String({
    description:
      "Context slug to write into, within the repository's scope. " +
      "Required: cue has no default or fallback context and a write with " +
      "none fails.",
  }),
  dir: Type.Optional(
    Type.String({
      description:
        "Run cue as if started in this directory instead of the session " +
        "directory. Mirrors the git -C convention; use to write into " +
        "another repository's scope.",
    }),
  ),
  store: Type.Optional(
    Type.String({
      description: "Root of the cue store, overriding $CUE_STORE. Rarely needed.",
    }),
  ),
})

export function cuePlanTool(pi: ExtensionAPI): ToolDefinition<typeof parameters> {
  return {
    name: "cue-plan",
    label: "cue plan",
    description: "Create a new plan artifact.",
    parameters,
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      return withTempFile(args.content, "cue-plan", "md", async (tempPath) => {
        const frontmatter: Record<string, string | string[]> = {
          status: args.status ?? "open",
          refs: args.refs ?? [],
        }
        if (args.parent) {
          frontmatter.parent = args.parent
        }
        const flags = [
          ...dirFlag(args.dir, ctx.cwd),
          ...storeFlag(args.store),
          ...contextFlag(args.context),
          ...frontmatterFlags(frontmatter),
        ]
        const output = await runCue(
          pi,
          ["add", ...flags, "--type", "plan", "--file", tempPath, args.filename],
          ctx.cwd,
        )
        return { content: [{ type: "text", text: output }], details: {} }
      })
    },
  }
}
