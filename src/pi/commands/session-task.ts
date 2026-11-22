import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { join } from "node:path"
import { parseArtifacts, isFinished } from "../browser/model"
import { currentContext } from "../lib/current-context"
import { fuzzySelect, type PickItem } from "../lib/fuzzy-select"
import { currentTask, syncSessionState } from "../lib/session-task"
import { applySessionTask } from "../tools/cue-session-task"
import { cueBestEffort } from "./common"
import { editInTerminal, storeRoot } from "./cue-browser"

/** Open the active task in $EDITOR. */
export const TASK_SHORTCUT = "ctrl+alt+t"

const CLEAR = "\0clear"

/** Picker items: clear first, then the unfinished tasks of the context. */
export function taskItems(listJson: string, context: string): PickItem[] {
  const tasks = parseArtifacts(listJson)
    .filter((a) => a.type === "task" && !isFinished(a.status))
    .map((a) => ({
      value: `${context}/task/${a.name}`,
      text: `${a.name} ${a.title}`,
      label: a.title,
      right: a.name.replace(/\.md$/, ""),
    }))
  return [{ value: CLEAR, label: "clear active task" }, ...tasks]
}

async function pickTask(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<string | null | undefined> {
  const context = currentContext(ctx.sessionManager.getBranch())
  if (!context) {
    ctx.ui.notify("cue: link a context first, or pass a task address", "warning")
    return undefined
  }
  const json = await cueBestEffort(pi, ctx.cwd, [
    "list", "--context", context, "--type", "task", "--json", "--frontmatter",
  ])
  const choice = await fuzzySelect(ctx.ui, "Active task", taskItems(json, context), {
    submitHint: "set",
  })
  if (!choice) return undefined
  return choice.value === CLEAR ? null : choice.value
}

async function handler(pi: ExtensionAPI, args: string, ctx: ExtensionContext) {
  const arg = args.trim()
  let address: string | undefined
  if (arg === "clear") address = undefined
  else if (arg !== "") address = arg
  else {
    const picked = await pickTask(pi, ctx)
    if (picked === undefined) return
    address = picked ?? undefined
  }
  try {
    const r = await applySessionTask(pi, ctx, address)
    ctx.ui.notify(`cue: ${r.text}`, "info")
  } catch (e) {
    ctx.ui.notify(`cue: ${e instanceof Error ? e.message : String(e)}`, "error")
  }
}

async function openActiveTask(ctx: ExtensionContext): Promise<void> {
  const task = currentTask(ctx.sessionManager.getBranch())
  if (!task) {
    ctx.ui.notify("cue: no active task; set one with /session-task", "warning")
    return
  }
  const path = join(storeRoot(ctx.cwd), task)
  await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
    void editInTerminal(tui, path).then(() => done())
    return { render: () => [], invalidate: () => {} }
  })
}

/**
 * Register `/session-task [<address>|clear]`, the open-task shortcut,
 * and the resync of CUE_TASK and the footer whenever the branch may
 * have changed (start, resume, fork, tree navigation).
 */
export function registerSessionTask(pi: ExtensionAPI): void {
  pi.registerCommand("session-task", {
    description: "Set the session's active task (no argument: pick; 'clear': clear it)",
    handler: (args, ctx) => handler(pi, args, ctx),
  })
  pi.registerShortcut(TASK_SHORTCUT, {
    description: "Open the session's active task in $EDITOR",
    handler: (ctx) => openActiveTask(ctx),
  })
  pi.on("session_start", async (_e, ctx) => syncSessionState(ctx))
  pi.on("session_tree", async (_e, ctx) => syncSessionState(ctx))
}
