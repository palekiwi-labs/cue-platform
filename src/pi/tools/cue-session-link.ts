import { existsSync } from "node:fs"
import { join } from "node:path"
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { linkContext } from "../commands/context-pins"
import { storeRoot } from "../commands/cue-browser"
import { currentContext } from "../lib/current-context"
import { applyContextName } from "../session-name"

const parameters = Type.Object({
  address: Type.String({
    description:
      "Canonical address of the context (<org>/<repo>/<context>) or of any " +
      "artifact inside it (<org>/<repo>/<context>/<type>/<name>); an " +
      "artifact address links its context.",
  }),
})

/**
 * Context address for a context or artifact address: its first three
 * segments. Undefined when the address is not canonical.
 */
export function contextAddressOf(address: string): string | undefined {
  const parts = address.trim().split("/").filter((p) => p !== "")
  if (parts.length < 3 || parts.some((p) => p === "." || p === "..")) {
    return undefined
  }
  return parts.slice(0, 3).join("/")
}

export function cueSessionLinkTool(pi: ExtensionAPI): ToolDefinition<typeof parameters> {
  return {
    name: "cue-session-link",
    label: "cue session link",
    description:
      "Link this session to a cue context, exactly as the operator does " +
      "from the context browser. Use it only on clear working intent " +
      "(\"let's work on <address>\"), never because a context was merely " +
      "mentioned or explored, and always say in your reply which context " +
      "you linked. Relinking to another context is allowed. Linking does " +
      "not inject the context and does not change the context cue tools " +
      "write to: keep passing `context` explicitly on every cue tool call.",
    parameters,
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      const address = contextAddressOf(args.address)
      if (!address) {
        throw new Error(
          `not a canonical address: ${args.address} ` +
            "(expected <org>/<repo>/<context>[/<type>/<name>])",
        )
      }
      const root = storeRoot(ctx.cwd)
      if (!existsSync(join(root, address, "context.md"))) {
        throw new Error(`no such context: ${address} (store ${root})`)
      }
      const previous = currentContext(ctx.sessionManager.getBranch())
      if (previous === address) {
        await applyContextName(pi, address)
        return {
          content: [{ type: "text", text: `Session already linked to ${address}.` }],
          details: { address, previous },
        }
      }
      await linkContext(pi, ctx, address)
      const from = previous ? ` (was ${previous})` : ""
      const text =
        `Session linked to ${address}${from}. ` +
        "Cue tools still need an explicit `context` argument. " +
        "Tell the operator which context you linked."
      return { content: [{ type: "text", text }], details: { address, previous } }
    },
  }
}
