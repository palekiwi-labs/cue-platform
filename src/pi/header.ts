import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { parseContextTree, ALL_TIME_DAYS, RECENCY_STEPS, recencyIndex, relativeAge } from "./browser/model"
import { NO_CONTEXT, recentSessions, sessionHeadline, type SessionRow } from "./browser/sessions"
import type { ContextRow } from "./browser/model"
import { loadSessions, SESSIONS_SHORTCUT, storedRecencyDays } from "./commands/cue-browser"
import { cueBestEffort } from "./commands/common"

export const HEADER_SESSIONS = 8

const LOGO = [
  "┌─┐┬ ┬┌─┐  ┌─┐┬  ┌─┐┌┬┐┌─┐┌─┐┬─┐┌┬┐",
  "│  │ │├┤   ├─┘│  ├─┤ │ ├┤ │ │├┬┘│││",
  "└─┘└─┘└─┘  ┴  ┴─┘┴ ┴ ┴ └  └─┘┴└─┴ ┴",
]

export interface Revision {
  hash: string
  branch?: string
  dirty: boolean
}

/** The git revision of a checkout; undefined outside a git work tree. */
export function readRevision(dir: string): Revision | undefined {
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" })
  const head = git("rev-parse", "--short", "HEAD")
  if (head.status !== 0) return undefined
  const branch = git("symbolic-ref", "--short", "-q", "HEAD")
  const status = git("status", "--porcelain")
  return {
    hash: head.stdout.trim(),
    branch: branch.status === 0 ? branch.stdout.trim() : undefined,
    dirty: status.status === 0 && status.stdout.trim() !== "",
  }
}

export function revisionText(rev: Revision | undefined): string {
  if (!rev) return "cue-platform (revision unknown)"
  const where = [rev.branch ?? "detached", ...(rev.dirty ? ["+dirty"] : [])].join(", ")
  return `cue-platform ${rev.hash} (${where})`
}

const LOADED_REVISION = readRevision(resolve(dirname(fileURLToPath(import.meta.url)), "../.."))

type Recent = { session: SessionRow; context: ContextRow }[]

export function headerLines(
  t: Theme,
  width: number,
  revision: Revision | undefined,
  recent: Recent | undefined,
  days: number,
  now: number,
): string[] {
  const fit = (s: string) => truncateToWidth(s, width, "…")
  const logo = LOGO.every((l) => visibleWidth(l) + 2 <= width)
    ? LOGO.map((l) => "  " + t.fg("accent", l))
    : ["  " + t.bold(t.fg("accent", "cue platform"))]
  const out = ["", ...logo, "  " + t.fg("dim", revisionText(revision)), ""]
  const title = `  recent sessions ${t.fg("dim", `(${days === ALL_TIME_DAYS ? "all-time" : `${days}d`})`)}`
  const hint = t.fg("dim", `${SESSIONS_SHORTCUT} to resume`)
  const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(hint) - 2)
  out.push(fit(title + " ".repeat(gap) + hint))
  if (!recent) out.push("  " + t.fg("dim", "loading…"))
  else if (recent.length === 0) out.push("  " + t.fg("dim", "no recent sessions"))
  for (const { session: s, context } of recent ?? []) {
    const age = t.fg("muted", relativeAge(s.modified, now).padStart(4))
    const where = context.address === NO_CONTEXT ? "-" : context.slug
    out.push(fit(`  ${age}  ${sessionHeadline(t, where, s.description, s.label)}`))
  }
  out.push("")
  return out
}

/** Replace pi's startup banner with the cue platform header. */
export function registerWelcomeHeader(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return
    const days = RECENCY_STEPS[recencyIndex(storedRecencyDays(ctx.cwd))]!
    let recent: Recent | undefined
    let rerender: (() => void) | undefined
    ctx.ui.setHeader((tui, theme) => {
      rerender = () => tui.requestRender()
      return {
        render: (width: number) =>
          headerLines(theme, width, LOADED_REVISION, recent, days, Math.floor(Date.now() / 1000)),
        invalidate() {},
      }
    })
    void Promise.all([
      cueBestEffort(pi, ctx.cwd, ["context", "tree", "--sort", "recency", "--json"]),
      loadSessions(pi, ctx.cwd),
    ]).then(([tree, sessions]) => {
      recent = recentSessions(parseContextTree(tree), sessions, Math.floor(Date.now() / 1000), days, HEADER_SESSIONS)
      rerender?.()
    }, () => {
      recent = []
      rerender?.()
    })
  })
}
