import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { contextFlag, dirFlag, storeFlag } from "../lib/cue-args"
import { runCue } from "../lib/cue-exec"
import { taskFrontmatter } from "../lib/cue-task-helpers"
import { frontmatterFlags } from "../lib/frontmatter"
import { withTempFile } from "../lib/temp"

const parameters = Type.Object({
  filename: Type.String({
    description:
      "Slug-based name (e.g. 'auth-login.md'). No numeric ID, no path separators.",
  }),
  content: Type.String({
    description: "Full body of the task: the goal and its completion condition.",
  }),
  title: Type.String({ description: "Short display title." }),
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("open"),
        Type.Literal("in-progress"),
        Type.Literal("complete"),
        Type.Literal("closed"),
      ],
      {
        description:
          'Status of the task. Defaults to "open": a task is created ' +
          "deliberately with a defined goal, so it is triaged by the act " +
          'of writing it. Promote to "in-progress" while working, ' +
          '"complete"/"closed" when done.',
      },
    ),
  ),
  priority: Type.Optional(
    Type.Union(
      [
        Type.Literal("critical"),
        Type.Literal("high"),
        Type.Literal("normal"),
        Type.Literal("low"),
      ],
      { description: "Priority of the task. The only scheduling field. Default: normal." },
    ),
  ),
  parent: Type.Optional(
    Type.String({
      description:
        "Canonical address of the parent task or context (e.g. " +
        "'palekiwi/palekiwi/cue-platform-direction'). Emitted as `parent:` " +
        "frontmatter.",
    }),
  ),
  refs: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Canonical addresses (<scope>/<context>/<type>/<name>) this task " +
        "links to, such as the spec it implements. Emitted as a `refs:` " +
        "YAML list.",
    }),
  ),
  context: Type.String({
    description:
      "Context slug to file the task under, within the repository's " +
      "scope. Required: task identity is namespaced by its context and " +
      "there is no global board. Create the context first if it does not " +
      "exist.",
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

export function cueTaskTool(pi: ExtensionAPI): ToolDefinition<typeof parameters> {
  return {
    name: "cue-task",
    label: "cue task",
    description:
      "Create a new task artifact inside a context. A task is the only " +
      "artifact that can be done: it is defined by a goal and a " +
      "completion condition.",
    parameters,
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      return withTempFile(args.content, "cue-task", "md", async (tempPath) => {
        const flags = [
          ...dirFlag(args.dir, ctx.cwd),
          ...storeFlag(args.store),
          ...contextFlag(args.context),
          ...frontmatterFlags(taskFrontmatter(args)),
        ]
        const output = await runCue(
          pi,
          ["add", ...flags, "--type", "task", "--file", tempPath, args.filename],
          ctx.cwd,
        )
        return { content: [{ type: "text", text: output }], details: {} }
      })
    },
  }
}
