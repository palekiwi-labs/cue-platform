import { existsSync } from "node:fs"
import { join } from "node:path"
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { linkContext } from "../commands/context-pins"
import { storeRoot } from "../commands/cue-browser"
import type { ActivityCtx } from "../lib/activity"
import { currentContext } from "../lib/current-context"
import {
  currentTask,
  normalizeTaskAddress,
  type SessionStateCtx,
  setSessionTask,
  taskContextOf,
} from "../lib/session-task"

const parameters = Type.Object({
  address: Type.Optional(
    Type.String({
      description:
        "Canonical task address (<org>/<repo>/<context>/task/<name>.md). " +
        "Omit to clear the active task.",
    }),
  ),
})

export interface SessionTaskResult {
  text: string
  task: string | undefined
  previous: string | undefined
}

/**
 * Set (address) or clear (no address) the session's active task. Setting
 * links the task's context first when the session is elsewhere, so the
 * two never diverge. Throws on a non-task address or a missing file.
 */
export async function applySessionTask(
  pi: ExtensionAPI,
  ctx: ActivityCtx & SessionStateCtx & { cwd: string },
  rawAddress: string | undefined,
  root: (cwd: string) => string = storeRoot,
): Promise<SessionTaskResult> {
  const previous = currentTask(ctx.sessionManager.getBranch())
  if (rawAddress === undefined || rawAddress.trim() === "") {
    if (!previous) return { text: "No active task to clear.", task: undefined, previous }
    setSessionTask(pi, ctx, null)
    return { text: `Active task cleared (was ${previous}).`, task: undefined, previous }
  }
  const address = normalizeTaskAddress(rawAddress)
  if (!address) {
    throw new Error(
      `not a task address: ${rawAddress} (expected <org>/<repo>/<context>/task/<name>.md)`,
    )
  }
  const store = root(ctx.cwd)
  if (!existsSync(join(store, address))) {
    throw new Error(`no such task: ${address} (store ${store})`)
  }
  if (previous === address) {
    return { text: `Active task already ${address}.`, task: address, previous }
  }
  const context = taskContextOf(address)!
  if (currentContext(ctx.sessionManager.getBranch()) !== context) {
    await linkContext(pi, ctx, context)
  }
  setSessionTask(pi, ctx, address)
  const from = previous ? ` (was ${previous})` : ""
  return { text: `Active task set to ${address}${from}.`, task: address, previous }
}

export function cueSessionTaskTool(pi: ExtensionAPI): ToolDefinition<typeof parameters> {
  return {
    name: "cue-session-task",
    label: "cue session task",
    description:
      "Set or clear the session's active task. With a task address it " +
      "becomes the active task and the session is linked to the task's " +
      "context (switching from a task in another context is allowed). " +
      "With no address the active task is cleared. Set it on clear " +
      "working intent for a task, clear it before linking another " +
      "context, and tell the operator what you set or cleared.",
    parameters,
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      const r = await applySessionTask(pi, ctx, args.address)
      return {
        content: [{ type: "text", text: r.text }],
        details: { task: r.task, previous: r.previous },
      }
    },
  }
}
