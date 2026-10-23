import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { appendFileSync, watchFile, unwatchFile } from "node:fs"
import { readFile } from "node:fs/promises"
import { currentContext, slugOf } from "./lib/current-context"

/**
 * Name the pi session, and the tmux window holding this pane, after the
 * slug of a cue context. tmux failures are ignored; the original window
 * name is not restored on exit.
 */
export async function applyContextName(
  pi: ExtensionAPI,
  address: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const slug = slugOf(address)
  if (!slug) return
  pi.setSessionName(slug)
  await renameTmuxWindow(pi, slug, env)
}

/** Window name for a session with no cue context and no name of its own. */
export const DEFAULT_WINDOW_NAME = "pi"

/** TEMP debug: log every rename decision to find the "pi" reverts. */
function debugLog(reason: string, name: string): void {
  try {
    appendFileSync(
      "/tmp/pi-name-debug/renames.log",
      `${new Date().toISOString()} reason=${reason} name=${name} pid=${process.pid}\n`,
    )
  } catch {
    /* debug only */
  }
}

/**
 * Rename the tmux window holding this pane; no-op outside tmux.
 *
 * Only an interactive pi that owns the pane's tty may rename: child
 * pi processes (subagents, `pi -p`, scripted helpers) inherit
 * TMUX_PANE and would otherwise clobber the parent window's name.
 */
export async function renameTmuxWindow(
  pi: ExtensionAPI,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  reason = "applyContextName",
): Promise<void> {
  if (!env.TMUX) return
  if (!process.stdout.isTTY) {
    debugLog(`skipped-non-tty reason=${reason}`, name)
    return
  }
  debugLog(reason, name)
  const target = env.TMUX_PANE ? ["-t", env.TMUX_PANE] : []
  try {
    await pi.exec("tmux", ["rename-window", ...target, name])
  } catch {
    // not fatal: naming is cosmetic
  }
}

/**
 * Re-apply the name whenever the current context may have changed
 * outside an injection: session start/resume/fork and tree navigation.
 * With no current context the session name is left alone and the tmux
 * window follows the session: its own name if it has one (e.g. /name),
 * else "pi" -- so switching to a new session does not keep the
 * previous session's window name.
 *
 * An explicit session rename (/name, RPC) is the user's intent and
 * always wins: the tmux window follows the new session name even when
 * a cue context had named it before.
 */
export function registerSessionNaming(
  pi: ExtensionAPI,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const sync = async (ctx: {
    sessionManager: { getBranch(): readonly { type: string }[] }
  }) => {
    const address = currentContext(ctx.sessionManager.getBranch())
    if (address) await applyContextName(pi, address, env)
    else {
      debugLog(
        `sync/else event session-name=${pi.getSessionName() ?? "undefined"}`,
        pi.getSessionName() || DEFAULT_WINDOW_NAME,
      )
      await renameTmuxWindow(
        pi,
        pi.getSessionName() || DEFAULT_WINDOW_NAME,
        env,
        "sync/else",
      )
    }
  }
  pi.on("session_start", async (_e, ctx) => {
    watchSessionFile(pi, ctx, env)
    await sync(ctx)
  })
  pi.on("session_tree", async (_e, ctx) => sync(ctx))
  pi.on("session_shutdown", () => stopWatchSessionFile())
  pi.on("session_info_changed", async (e) =>
    renameTmuxWindow(
      pi,
      e.name || DEFAULT_WINDOW_NAME,
      env,
      `session_info_changed name=${e.name ?? "undefined"}`,
    ),
  )
}

/**
 * Latest session display name recorded in the session file, from the
 * last "session_info" entry in file order.
 */
export async function latestFileSessionName(
  file: string,
): Promise<string | undefined> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch {
    return undefined
  }
  let name: string | undefined
  for (const line of text.split("\n")) {
    if (!line) continue
    try {
      const entry = JSON.parse(line)
      if (entry?.type === "session_info" && entry.name)
        name = String(entry.name)
    } catch {
      // tolerate trailing partial lines from concurrent appends
    }
  }
  return name
}

/** Session file currently watched by watchSessionFile (module-level so
 * session switches can replace/clear it). */
let watchedFile: string | undefined

/**
 * Renaming from the session tree (C-r) writes a session_info entry
 * straight to the session file through a separate SessionManager, with
 * no session_info_changed event. Poll the file (watchFile: robust to
 * inode changes) so the tmux window follows those renames too. Only
 * the tmux window is touched: the running session's in-memory name
 * stays as-is (pi keeps them in sync only on reload).
 */
export function watchSessionFile(
  pi: ExtensionAPI,
  ctx: { sessionManager: { getSessionFile(): string | undefined } },
  env: NodeJS.ProcessEnv,
): void {
  stopWatchSessionFile()
  const file = ctx.sessionManager.getSessionFile()
  if (!file) return
  watchedFile = file
  const onChange = async (): Promise<void> => {
    const name = await latestFileSessionName(file)
    if (name !== undefined && name !== last) {
      last = name
      void renameTmuxWindow(pi, name, env, "file-watch")
    }
  }
  let last: string | undefined
  void onChange().then(() => {
    if (watchedFile !== file) return // superseded while reading
    watchFile(file, { interval: 2000 }, () => void onChange())
  })
}

/** Stop watching, e.g. on session shutdown or when switching files. */
export function stopWatchSessionFile(): void {
  if (watchedFile) unwatchFile(watchedFile)
  watchedFile = undefined
}
