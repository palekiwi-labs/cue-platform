import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { contextFlag, dirFlag, storeFlag } from "../lib/cue-args"
import { runCue } from "../lib/cue-exec"
import { frontmatterFlags } from "../lib/frontmatter"
import { withTempFile } from "../lib/temp"

/**
 * The single write door for review artifacts in pi sessions.
 *
 * `cue add --type review` remains the CLI surface, but the bridge exposes
 * review only through this tool: a dedicated name makes review writes
 * distinguishable in the tool stream, and one choke point lets permission
 * profiles grant or deny review production per agent without touching
 * generic artifact creation.
 *
 * Control carried here rather than in cue core: the payload must be a JSON
 * object before cue is invoked (fail fast, no round-trip), and existing
 * artifacts are never overwritten — a rerun gets a new name, because a
 * review is a point-in-time record.
 */
const parameters = Type.Object({
  content: Type.String({
    description:
      "Complete JSON object payload. Must parse as a JSON object (not an " +
      "array or scalar); anything else is rejected before cue runs.",
  }),
  filename: Type.String({
    description:
      "Name of the file (e.g. '<run-id>/reviewer-opus.json', 'review-findings.json'). " +
      "Nested relative paths are allowed (e.g. 'runs/<run-id>/findings.json'); " +
      "absolute paths and '..' are not. Extensionless names get '.json'.",
  }),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())]), {
      description:
        "Fields merged into the object as top-level JSON keys — the " +
        "metadata channel for JSON artifacts, never a YAML prefix. A list " +
        "value emits one entry per element (e.g. { reviewers: ['a', 'b'] }).",
    }),
  ),
  context: Type.String({
    description:
      "Context slug to write into, within the repository's scope. " +
      "Required: cue has no default or fallback context and a write with " +
      "none fails. Discover slugs with `cue context list`.",
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

export function cueReviewTool(pi: ExtensionAPI): ToolDefinition<typeof parameters> {
  return {
    name: "cue-review",
    label: "cue review",
    description:
      "Create a JSON review artifact (reviewer payloads, findings, " +
      "manifests). This is the only way to write review artifacts: " +
      "cue-add does not expose the review type. Content must be a JSON " +
      "object; cue adds no timestamps or revision stamps, and existing " +
      "files are never overwritten.",
    parameters,
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      // Bridge-level control: reject a non-object payload before cue runs,
      // so the producer gets this tool's diagnostic rather than a cue
      // round-trip.
      let parsed: unknown
      try {
        parsed = JSON.parse(args.content)
      } catch (error) {
        throw new Error(
          `cue-review content must be valid JSON: ${(error as Error).message}`,
        )
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(
          "cue-review content must be a JSON object, not an array or scalar",
        )
      }

      return withTempFile(args.content, "cue-review", "json", async (tempPath) => {
        const flags = [
          ...dirFlag(args.dir, ctx.cwd),
          ...storeFlag(args.store),
          ...contextFlag(args.context),
          ...(args.metadata ? frontmatterFlags(args.metadata) : []),
        ]
        const output = await runCue(
          pi,
          ["add", ...flags, "--type", "review", "--file", tempPath, args.filename],
          ctx.cwd,
        )
        return { content: [{ type: "text", text: output }], details: {} }
      })
    },
  }
}
