import { spawn } from "node:child_process"
import { dirname } from "node:path"
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { type BrowserDeps, type BrowserStart, CueBrowser, type Target } from "../browser/browser"
import { parseArtifacts, parseContextTree } from "../browser/model"
import { currentContext, slugOf } from "../lib/current-context"
import { cueBestEffort } from "./common"
import { linkContext } from "./context-pins"

/** Open the contexts view. Replaces the old pins picker on this key. */
export const CONTEXTS_SHORTCUT = "alt+c"
/** Open the artifacts of the session's (or the global) context. */
export const ARTIFACTS_SHORTCUT = "alt+a"

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
 * cannot call newSession, so dispatch the resume picker's hidden
 * /resume-open command (extensions/tmux-resume.ts), as it does itself.
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
        link: (address) => linkContext(pi, address),
        editFile: (path) => editInTerminal(tui, path),
        openInTmux,
        copy: copyToClipboard,
        create: (address, type, filename) =>
          createArtifact(pi, ctx.cwd, address, type, filename),
        newSession: (address, target) => newSession(pi, ctx, address, target),
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
  pi.registerShortcut(ARTIFACTS_SHORTCUT, {
    description: "Browse artifacts of the session context (or the global one)",
    handler: async (ctx) => openArtifacts(pi, ctx),
  })
}
