import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { type BrowserDeps, type BrowserStart, CueBrowser, type Target } from "../browser/browser"
import { parseArtifacts, parseContextTree } from "../browser/model"
import { inScopes, type SessionRow, scopeOfRemote, sessionMeta } from "../browser/sessions"
import { currentContext, slugOf } from "../lib/current-context"
import { cueBestEffort } from "./common"
import { linkContext } from "./context-pins"

/** Open the contexts view. Replaces the old pins picker on this key. */
export const CONTEXTS_SHORTCUT = "alt+c"
/** Open the artifacts of the session's (or the global) context. */
export const ARTIFACTS_SHORTCUT = "alt+a"
/** Open the sessions view (the resume picker). */
export const SESSIONS_SHORTCUT = "ctrl+r"

const editorCommand = (): string =>
  process.env.VISUAL || process.env.EDITOR || "nvim"

/** Hand the terminal to $EDITOR, as pi's own external-editor action does. */
async function editInTerminal(tui: TUI, path: string): Promise<void> {
  tui.stop()
  try {
    await new Promise<void>((resolve) => {
      const [cmd, ...args] = editorCommand().split(/\s+/)
      const child = spawn(cmd!, [...args, path], { stdio: "inherit" })
      child.on("close", () => resolve())
      child.on("error", () => resolve())
    })
  } finally {
    tui.start()
    tui.requestRender(true)
  }
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/** Run a shell command in a new tmux window; error text on failure. */
function tmuxWindow(name: string, cwd: string, command: string): string | undefined {
  if (!process.env.TMUX) return "not inside tmux"
  spawn("tmux", ["new-window", "-n", name, "-c", cwd, command], {
    detached: true,
    stdio: "ignore",
  }).unref()
  return undefined
}

/** Open a file in a new tmux window next to pi; error text on failure. */
function openInTmux(path: string): string | undefined {
  const name = path.split("/").pop() ?? "cue"
  return tmuxWindow(name, dirname(path), `${editorCommand()} ${shellQuote(path)}`)
}

/**
 * Start a fresh pi session for a context. Here: shortcut contexts
 * cannot call newSession, so dispatch the hidden /resume-open command,
 * whose command context can.
 * In tmux: a new window running pi with the inject command as its
 * first message.
 */
function newSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  address: string,
  target: Target,
): string | undefined {
  if (target === "tmux") {
    const inject = `/cue:context:inject ${address}`
    return tmuxWindow(slugOf(address) || "pi", ctx.cwd, `pi ${shellQuote(inject)}`)
  }
  if (!ctx.isIdle()) return "wait for the agent to finish to start a session here"
  pi.sendUserMessage(`/resume-open new ${address}`, { expandPromptTemplates: true })
  return undefined
}

/** Resume a session here (via /resume-open) or in a new tmux window. */
function resumeSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  session: SessionRow,
  target: Target,
): string | undefined {
  if (target === "tmux") {
    const name = session.address ? slugOf(session.address) : "pi"
    return tmuxWindow(name || "pi", session.cwd || ctx.cwd, `pi --session ${shellQuote(session.path)}`)
  }
  if (!ctx.isIdle()) return "wait for the agent to finish to resume here"
  pi.sendUserMessage(`/resume-open ${session.path}`, { expandPromptTemplates: true })
  return undefined
}

/** Scope of a working directory from its git origin; cached per cwd. */
const cwdScopes = new Map<string, string | undefined>()
function cwdScope(cwd: string): string | undefined {
  if (!cwdScopes.has(cwd)) {
    let scope: string | undefined
    if (existsSync(cwd)) {
      const r = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8" })
      if (r.status === 0) scope = scopeOfRemote(r.stdout)
    }
    cwdScopes.set(cwd, scope)
  }
  return cwdScopes.get(cwd)
}

/** Every pi session in the scopes of this repository's context tree. */
async function loadSessions(pi: ExtensionAPI, cwd: string): Promise<SessionRow[]> {
  const [tree, infos] = await Promise.all([
    cueBestEffort(pi, cwd, ["context", "tree", "--json"]),
    SessionManager.listAll(),
  ])
  const scopes = new Set(parseContextTree(tree).map((c) => c.scope))
  const rows = await Promise.all(infos.map(async (info): Promise<SessionRow> => {
    const meta = sessionMeta(await readFile(info.path, "utf8").catch(() => ""))
    const fallback = (info.name?.trim() || info.firstMessage || "(empty)").replace(/\s+/g, " ").slice(0, 80)
    return {
      path: info.path,
      cwd: info.cwd,
      address: meta.address,
      description: meta.description ?? fallback,
      label: meta.label,
      tokens: meta.tokens,
      modified: Math.floor(info.modified.getTime() / 1000),
    }
  }))
  return inScopes(rows, scopes, cwdScope)
}

/** Prefer the trash CLI, as pi's own picker does; fall back to unlink. */
async function deleteSessionFile(path: string): Promise<string> {
  try {
    const r = spawnSync("trash", [path], { encoding: "utf8" })
    if (r.status === 0 || !existsSync(path)) return "moved to trash"
  } catch {
    // no trash CLI
  }
  await unlink(path)
  return "deleted"
}

async function createArtifact(
  pi: ExtensionAPI,
  cwd: string,
  address: string,
  type: string,
  filename: string,
): Promise<{ path: string } | { error: string }> {
  const status = type === "task" || type === "plan" ? ["-f", "status=open"] : []
  const r = await pi.exec(
    "cue",
    ["add", "--type", type, "--context", address, ...status, filename, ""],
    { cwd },
  )
  const out = r.stdout.trim().split("\n").pop() ?? ""
  if (r.code !== 0 || !out.startsWith("/")) {
    return { error: (r.stderr || r.stdout).trim() || `cue add failed (${r.code})` }
  }
  return { path: out }
}

/** The session's linked context, else the global (branch/env) one. */
async function resolveContext(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<string | undefined> {
  const linked = currentContext(ctx.sessionManager.getBranch())
  if (linked) return linked
  try {
    const status = JSON.parse(
      await cueBestEffort(pi, ctx.cwd, ["status", "--json"], "{}"),
    ) as { address?: unknown }
    return typeof status.address === "string" ? status.address : undefined
  } catch {
    return undefined
  }
}

export async function openBrowser(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  start: BrowserStart,
): Promise<void> {
  if (!ctx.hasUI) return
  const sessionAddress = () => currentContext(ctx.sessionManager.getBranch())
  await ctx.ui.custom<void>(
    (tui, theme, kb, done) => {
      const deps: BrowserDeps = {
        loadContexts: async (pinnedOnly) =>
          parseContextTree(
            await cueBestEffort(pi, ctx.cwd, [
              "context", "tree", "--sort", "recency", "--json",
              ...(pinnedOnly ? ["--pinned"] : []),
            ]),
          ),
        loadArtifacts: async (address) =>
          parseArtifacts(
            await cueBestEffort(pi, ctx.cwd, [
              "list", "--context", address, "--json", "--frontmatter",
            ]),
          ),
        sessionAddress,
        setPinned: async (address, pinned) => {
          const r = await pi.exec("cue", ["context", pinned ? "pin" : "unpin", address], {
            cwd: ctx.cwd,
          })
          return r.code === 0 ? undefined : r.stderr.trim() || `cue context ${pinned ? "pin" : "unpin"} failed`
        },
        link: (address) => linkContext(pi, address),
        editFile: (path) => editInTerminal(tui, path),
        openInTmux,
        copy: copyToClipboard,
        create: (address, type, filename) =>
          createArtifact(pi, ctx.cwd, address, type, filename),
        newSession: (address, target) => newSession(pi, ctx, address, target),
        loadSessions: () => loadSessions(pi, ctx.cwd),
        currentSession: () => ctx.sessionManager.getSessionFile(),
        resume: (session, target) => resumeSession(pi, ctx, session, target),
        deleteSession: deleteSessionFile,
      }
      return new CueBrowser(tui, theme, kb, deps, () => done(), start)
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
        margin: 0,
      },
    },
  )
}

async function openArtifacts(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const address = await resolveContext(pi, ctx)
  if (!address) {
    ctx.ui.notify("cue: no session or global context; opening contexts", "info")
    return openBrowser(pi, ctx, { view: "contexts" })
  }
  return openBrowser(pi, ctx, {
    view: "artifacts",
    context: { address, slug: slugOf(address) },
  })
}

/** Register the browser commands and their shortcuts. */
export function registerCueBrowser(pi: ExtensionAPI): void {
  pi.registerCommand("cue:browse", {
    description: "Browse cue contexts (full screen)",
    handler: async (_args, ctx) => openBrowser(pi, ctx, { view: "contexts" }),
  })
  pi.registerCommand("cue:artifacts", {
    description: "Browse artifacts of the session context (or the global one)",
    handler: async (_args, ctx) => openArtifacts(pi, ctx),
  })
  pi.registerShortcut(CONTEXTS_SHORTCUT, {
    description: "Browse cue contexts (full screen)",
    handler: async (ctx) => openBrowser(pi, ctx, { view: "contexts" }),
  })
  pi.registerCommand("cue:sessions", {
    description: "Browse and resume pi sessions, grouped by cue context",
    handler: async (_args, ctx) => openBrowser(pi, ctx, { view: "sessions" }),
  })
  pi.registerShortcut(SESSIONS_SHORTCUT, {
    description: "Browse and resume pi sessions, grouped by cue context",
    handler: async (ctx) => openBrowser(pi, ctx, { view: "sessions" }),
  })
  // Hidden dispatcher: shortcut contexts cannot switch or start sessions,
  // so the browser routes through this command, whose context can.
  pi.registerCommand("resume-open", {
    description: "Internal: switch to or start a session for the cue browser",
    handler: async (args, ctx) => {
      const [verb, ...rest] = args.trim().split(/\s+/)
      if (verb === "new") {
        const address = rest.join("")
        if (!address) return
        await ctx.newSession({
          withSession: async (nctx) => {
            await nctx.sendUserMessage(`/cue:context:inject ${address}`, { expandPromptTemplates: true })
          },
        })
        return
      }
      const path = args.trim()
      if (path) await ctx.switchSession(path)
    },
  })
  pi.registerShortcut(ARTIFACTS_SHORTCUT, {
    description: "Browse artifacts of the session context (or the global one)",
    handler: async (ctx) => openArtifacts(pi, ctx),
  })
}
