import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { dirFlag, storeFlag } from "../lib/cue-args"
import { contextCreateFlags } from "../lib/cue-context-helpers"
import { runCue } from "../lib/cue-exec"

const parameters = Type.Object({
  name: Type.String({
    pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
    description:
      "Immutable context slug, a single path segment (e.g. 'auth-redesign'). " +
      "This is identity and cannot be changed later; put wording that may " +
      "change in title.",
  }),
  title: Type.Optional(
    Type.String({
      description:
        "Presentation name, free prose. Distinct from the slug so it can " +
        "be reworded without breaking addresses.",
    }),
  ),
  kind: Type.Optional(
    Type.Union([Type.Literal("work"), Type.Literal("coord"), Type.Literal("reference")], {
      description:
        "What ends this context. work finishes when its goal is met; coord " +
        "is a standing arrangement across repositories or child contexts " +
        "and does not finish; reference is durable material that is never " +
        "done. Default: work.",
    }),
  ),
  mode: Type.Optional(
    Type.Union(
      [
        Type.Literal("research"),
        Type.Literal("design"),
        Type.Literal("build"),
        Type.Literal("review"),
        Type.Literal("learn"),
      ],
      {
        description:
          "Advisory default session mode, the behavioural contract a session " +
          "in this context adopts. Advisory only: a single session may " +
          "override it.",
      },
    ),
  ),
  description: Type.Optional(
    Type.String({ description: "One-line description for listings." }),
  ),
  parent: Type.Optional(
    Type.String({
      description:
        "Canonical address of the parent context (e.g. " +
        "'palekiwi/palekiwi/cue-platform-direction'). Children are derived " +
        "by scanning for this field, so the parent record needs no edit.",
    }),
  ),
  refs: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Canonical addresses of related contexts or artifacts " +
        "(<scope>/<context> or <scope>/<context>/<type>/<name>).",
    }),
  ),
  dir: Type.Optional(
    Type.String({
      description:
        "Run cue as if started in this directory instead of the session " +
        "directory. Mirrors the git -C convention; the repository's origin " +
        "remote is what determines the scope the context lands in.",
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

export function cueContextTool(pi: ExtensionAPI): ToolDefinition<typeof parameters> {
  return {
    name: "cue-context",
    label: "cue context",
    description:
      "Create a context in the repository's scope. A context is the base " +
      "unit of cue: it owns the log, the spec, the plans, the notes and " +
      "the tasks for one piece of work. Every artifact write requires an " +
      "existing context and cue has no default, so start a new piece of " +
      "work by creating its context first. List existing slugs with " +
      "`cue context list`.",
    parameters,
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      const flags = [
        ...dirFlag(args.dir, ctx.cwd),
        ...storeFlag(args.store),
        ...contextCreateFlags(args),
      ]
      const output = await runCue(pi, ["context", "create", ...flags, args.name], ctx.cwd)
      return { content: [{ type: "text", text: output }], details: {} }
    },
  }
}
