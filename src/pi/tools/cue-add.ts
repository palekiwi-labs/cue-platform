import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { contextFlag, dirFlag, storeFlag } from "../lib/cue-args"
import { runCue } from "../lib/cue-exec"
import { frontmatterFlags } from "../lib/frontmatter"
import { withTempFile } from "../lib/temp"

const parameters = Type.Object({
  type: Type.Optional(
    Type.Union(
      [
        Type.Literal("spec"),
        Type.Literal("plan"),
        Type.Literal("note"),
        Type.Literal("task"),
        Type.Literal("trace"),
        Type.Literal("bin"),
        Type.Literal("tmp"),
      ],
      {
        description:
          "Type of the artifact. spec is WHY, plan is HOW, task is WHAT, " +
          "note is idea capture; trace is a markdown artifact about a " +
          "revision (hand-offs, diagnostics, review walkthroughs), stamped " +
          "with repo_id and commit_hash; bin is an executable script stored " +
          "verbatim with the executable bit and carries no metadata; tmp " +
          "holds arbitrary files in a commit-pinned directory. " +
          "Default: spec. Review artifacts are not created here; use the " +
          "cue-review tool.",
      },
    ),
  ),
  filename: Type.String({
    description:
      "Name of the file (e.g. 'migration-report.md', 'ideas/auth.md'). " +
      "Nested relative paths are allowed; absolute paths and '..' are not. " +
      "Extensionless names get '.md' appended for markdown types.",
  }),
  content: Type.String({ description: "Full content of the artifact" }),
  frontmatter: Type.Optional(
    Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())]), {
      description:
        "Metadata fields for the artifact. Markdown types carry them as a " +
        "YAML frontmatter block; a list value becomes a YAML list " +
        "(e.g. { refs: ['palekiwi/palekiwi/cue-review/spec/index.md'] }). " +
        "bin rejects metadata entirely. created_at is stamped by cue; " +
        "never set it here.",
    }),
  ),
  context: Type.String({
    description:
      "Context slug to write into, within the repository's scope. Required: " +
      "cue has no default or fallback context and a write with none fails. " +
      "Discover slugs with `cue context list`.",
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
      description:
        "Root of the cue store, overriding $CUE_STORE. Rarely needed; the " +
        "devshell exports the store every sandbox shares.",
    }),
  ),
})

export function cueAddTool(pi: ExtensionAPI): ToolDefinition<typeof parameters> {
  return {
    name: "cue-add",
    label: "cue add",
    description:
      "Create a new cue artifact (spec, plan, note, task, trace, bin, tmp). " +
      "Review artifacts are not created here; use the cue-review tool.",
    parameters,
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      return withTempFile(args.content, "cue-add", "md", async (tempPath) => {
        const flags = [
          ...dirFlag(args.dir, ctx.cwd),
          ...storeFlag(args.store),
          ...contextFlag(args.context),
          ...(args.frontmatter ? frontmatterFlags(args.frontmatter) : []),
        ]
        const output = await runCue(
          pi,
          ["add", ...flags, "--type", args.type ?? "spec", "--file", tempPath, args.filename],
          ctx.cwd,
        )
        return { content: [{ type: "text", text: output }], details: {} }
      })
    },
  }
}
