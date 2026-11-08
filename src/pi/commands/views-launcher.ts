import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { fuzzySelect, type PickItem } from "../lib/fuzzy-select"
import { AGENTS_SHORTCUT, openMonitor } from "./agent-monitor"
import {
  ACTIVITY_SHORTCUT,
  ARTIFACTS_SHORTCUT,
  CONTEXTS_SHORTCUT,
  openActivity,
  openArtifacts,
  openBrowser,
  SESSIONS_SHORTCUT,
} from "./cue-browser"
import { openPrBrowser, PRS_SHORTCUT } from "./prs"

/** Open the views launcher. */
export const VIEWS_SHORTCUT = "f2"

/** A launcher entry: a view and the shortcut that also opens it. */
export interface LauncherView {
  label: string
  shortcut?: string
  open: (pi: ExtensionAPI, ctx: ExtensionContext) => Promise<void>
}

/** The views the launcher offers, in display order. */
export const VIEWS: readonly LauncherView[] = [
  {
    label: "contexts",
    shortcut: CONTEXTS_SHORTCUT,
    open: (pi, ctx) => openBrowser(pi, ctx, { view: "contexts" }),
  },
  { label: "artifacts", shortcut: ARTIFACTS_SHORTCUT, open: openArtifacts },
  {
    label: "sessions",
    shortcut: SESSIONS_SHORTCUT,
    open: (pi, ctx) => openBrowser(pi, ctx, { view: "sessions" }),
  },
  { label: "activity", shortcut: ACTIVITY_SHORTCUT, open: openActivity },
  { label: "GitHub PRs", shortcut: PRS_SHORTCUT, open: openPrBrowser },
  { label: "agent monitor", shortcut: AGENTS_SHORTCUT, open: openMonitor },
]

/** Picker items for the views, with each shortcut in the meta column. */
export function launcherItems(views: readonly LauncherView[]): PickItem[] {
  return views.map((v) => ({ value: v.label, right: v.shortcut }))
}

async function openLauncher(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return
  const picked = await fuzzySelect(ctx.ui, "Open view", launcherItems(VIEWS), {
    submitHint: "open",
  })
  const view = VIEWS.find((v) => v.label === picked?.value)
  if (view) await view.open(pi, ctx)
}

export function registerViewsLauncher(pi: ExtensionAPI): void {
  pi.registerCommand("cue:views", {
    description: "Pick a view to open",
    handler: async (_args, ctx) => openLauncher(pi, ctx),
  })
  pi.registerShortcut(VIEWS_SHORTCUT, {
    description: "Pick a view to open",
    handler: async (ctx) => openLauncher(pi, ctx),
  })
}
