import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { contextChildren } from "../lib/context-children"
import {
  CUE_CONTEXT_TYPE,
  type CueContextDetails,
  slugOf,
} from "../lib/current-context"
import { applyContextName } from "../session-name"
import { parseTree, treePrefix, type TreeEntry } from "../lib/context-tree"
import { fuzzySelect, type PickItem } from "../lib/fuzzy-select"
import { formatGitContext, gitContext } from "../lib/git-context"
import { composeMessage, cueBestEffort } from "./common"

/**
 * Gather the orientation block for a context: pwd, git, status, direct
 * children, log and master plan. Data only; no instructions, so the
 * operator's next prompt decides what to do with it. Queries pass the
 * full canonical address, so contexts outside the cwd's scope resolve.
 */
export async function contextOrientation(
  pi: ExtensionAPI,
  cwd: string,
  address: string,
): Promise<string> {
  const slug = slugOf(address)
  const git = formatGitContext(await gitContext(pi, cwd))
  const ctxArgs = ["--context", address]
  const status = await cueBestEffort(pi, cwd, ["status", ...ctxArgs])
  const children = await contextChildren(pi, cwd, address)
  const log = await cueBestEffort(pi, cwd, [
    "log",
    "list",
    ...ctxArgs,
    "--format",
    "md",
  ])
  const rendered = await cueBestEffort(pi, cwd, [
    "render",
    ...ctxArgs,
    "plan/index.md",
  ])
  return composeMessage([
    `Active cue context for this session: ${slug}`,
    `PWD: ${cwd}`,
    git,
    `<status>\n${status}\n</status>`,
    children,
    `<log>\n${log}\n</log>`,
    rendered,
  ])
}

/**
 * Inject a context into the session without starting a turn. Sent while
 * idle with no delivery options, pi persists it as a displayed
 * custom_message entry immediately (`deliverAs: "nextTurn"` would hold it
 * in memory, unseen and unpersisted, until the next prompt).
 */
export async function injectContext(
  pi: ExtensionAPI,
  cwd: string,
  address: string,
): Promise<void> {
  const details: CueContextDetails = { address }
  pi.sendMessage({
    customType: CUE_CONTEXT_TYPE,
    content: await contextOrientation(pi, cwd, address),
    display: true,
    details,
  })
  await applyContextName(pi, address)
}

/**
 * Associate a context with the session without telling the model: a
 * `custom` session entry (never in the LLM context) records it for
 * currentContext, and the session and tmux window take its slug. Safe
 * while the agent is busy since the conversation is untouched.
 */
export async function linkContext(
  pi: ExtensionAPI,
  address: string,
): Promise<void> {
  const data: CueContextDetails = { address }
  pi.appendEntry(CUE_CONTEXT_TYPE, data)
  await applyContextName(pi, address)
}

/**
 * Picker items for pinned contexts, as a parent-child tree like
 * cue.nvim's pins picker. Values are addresses (slugs may repeat across
 * scopes); labels are the tree-indented slugs.
 *
 * When pins span multiple scopes (custom scope in a coordination
 * workspace), every row gains the scope as a muted right column and
 * the fuzzy haystack includes it, so bare slugs stay unambiguous and
 * typing a repo name narrows to that repo's pins. Single-scope lists
 * render exactly as before.
 */
export function pinItems(entries: readonly TreeEntry[]): PickItem[] {
  const scopes = new Set(
    entries.map((e) => e.address.slice(0, e.address.length - e.slug.length - 1)),
  )
  const mixed = scopes.size > 1
  return entries.map((e) => ({
    value: e.address,
    text: mixed ? `${e.slug} ${e.address}` : e.slug,
    label: treePrefix(e) + e.slug,
    flat: e.slug,
    ...(mixed ? { right: e.address.slice(0, e.address.length - e.slug.length - 1) } : {}),
  }))
}

async function handler(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const entries = parseTree(
    await cueBestEffort(pi, ctx.cwd, [
      "context",
      "tree",
      "--pinned",
      "--sort",
      "recency",
      "--json",
    ]),
  )
  if (entries.length === 0) {
    ctx.ui.notify("cue: no pinned contexts in this scope", "info")
    return
  }
  const choice = await fuzzySelect(ctx.ui, "Cue context", pinItems(entries), {
    submitHint: "inject",
    altHint: "link only",
  })
  if (!choice) return
  if (choice.action === "alt") {
    await linkContext(pi, choice.value)
    return
  }
  if (!ctx.isIdle()) {
    ctx.ui.notify(
      "cue: wait for the agent to finish to inject (alt+enter links only)",
      "warning",
    )
    return
  }
  await injectContext(pi, ctx.cwd, choice.value)
}

/** Keybinding that opens the pins picker, same as `/cue:context:pins`. */
export const CONTEXT_PINS_SHORTCUT = "alt+c"

/**
 * Register `/cue:context:pins` and its keybinding: pick a pinned context
 * and inject it (enter) or only link it to the session (alt+enter).
 */
export function registerContextPinsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("cue:context:pins", {
    description:
      "Pick a pinned cue context: enter injects it, alt+enter only links it",
    handler: async (_args, ctx) => handler(pi, ctx),
  })
  pi.registerShortcut(CONTEXT_PINS_SHORTCUT, {
    description:
      "Pick a pinned cue context: enter injects it, alt+enter only links it",
    handler: async (ctx) => handler(pi, ctx),
  })
}
