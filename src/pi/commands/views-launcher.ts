import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import {
  type Component,
  matchesKey,
  type OverlayHandle,
  truncateToWidth,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui"
import { setViewSwitcher, type ViewSwitcher } from "../lib/view-switch"
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

const TITLE = "views"
const FOOTER = "enter open • esc close"

interface MenuTheme {
  fg(color: any, text: string): string
  bold(text: string): string
}

/** Width of the boxed menu for these views. */
export function menuWidth(views: readonly LauncherView[]): number {
  const labelWidth = Math.max(0, ...views.map((v) => visibleWidth(v.label)))
  const keyWidth = Math.max(0, ...views.map((v) => visibleWidth(v.shortcut ?? "")))
  const body = 2 + labelWidth + 4 + keyWidth
  return Math.max(body, visibleWidth(TITLE) + 2, visibleWidth(FOOTER) + 2) + 4
}

/** Boxed list of views with a moving selection, styled like the key help. */
export class ViewMenu implements Component {
  selected = 0

  constructor(
    private theme: MenuTheme,
    private views: readonly LauncherView[],
  ) {}

  invalidate(): void {}

  move(delta: number): void {
    const n = this.views.length
    this.selected = (this.selected + delta + n) % n
  }

  current(): LauncherView | undefined {
    return this.views[this.selected]
  }

  render(width: number): string[] {
    const t = this.theme
    const inner = Math.max(1, width - 4)
    const labelWidth = Math.max(0, ...this.views.map((v) => visibleWidth(v.label)))
    const body = this.views.map((v, i) => {
      const on = i === this.selected
      const label = v.label.padEnd(labelWidth)
      const key = t.fg("warning", v.shortcut ?? "")
      return on
        ? t.fg("accent", "> " + t.bold(label)) + "    " + key
        : "  " + label + "    " + key
    })
    const border = (s: string) => t.fg("border", s)
    const head = ` ${TITLE} `
    const foot = ` ${FOOTER} `
    const top = border("╭─") + t.fg("accent", t.bold(head)) +
      border("─".repeat(Math.max(0, width - 3 - visibleWidth(head))) + "╮")
    const bottom = border("╰" + "─".repeat(Math.max(0, width - 3 - visibleWidth(foot)))) +
      t.fg("dim", foot) + border("─╯")
    const row = (s: string) => {
      const cut = truncateToWidth(s, inner, "…")
      return border("│ ") + cut + " ".repeat(Math.max(0, inner - visibleWidth(cut))) + border(" │")
    }
    return [top, ...body.map(row), bottom].map((l) => truncateToWidth(l, width))
  }
}

/** The menu as a component that reports a pick, or null on cancel. */
function menuComponent(
  tui: TUI,
  theme: Theme,
  kb: KeybindingsManager,
  finish: (view: LauncherView | null) => void,
): Component {
  const menu = new ViewMenu(theme, VIEWS)
  return {
    render: (width: number) => menu.render(width),
    invalidate: () => menu.invalidate(),
    handleInput(data: string) {
      if (kb.matches(data, "tui.select.up")) menu.move(-1)
      else if (kb.matches(data, "tui.select.down")) menu.move(1)
      else if (kb.matches(data, "tui.select.confirm")) return finish(menu.current() ?? null)
      else if (kb.matches(data, "tui.select.cancel") || matchesKey(data, VIEWS_SHORTCUT)) {
        return finish(null)
      }
      tui.requestRender()
    },
  }
}

const MENU_OPTIONS = { anchor: "center", width: menuWidth(VIEWS) } as const

async function openLauncher(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return
  const view = await ctx.ui.custom<LauncherView | null>(
    (tui, theme, kb, done) => menuComponent(tui, theme, kb, done),
    { overlay: true, overlayOptions: MENU_OPTIONS },
  )
  if (view) await view.open(pi, ctx)
}

function switcher(pi: ExtensionAPI): ViewSwitcher {
  return (ctx, tui, theme, kb, close) => {
    let handle: OverlayHandle | undefined
    const menu = menuComponent(tui, theme, kb, (view) => {
      handle?.hide()
      tui.requestRender()
      if (!view) return
      close()
      void view.open(pi, ctx)
    })
    handle = tui.showOverlay(menu, MENU_OPTIONS)
    tui.requestRender()
  }
}

export function registerViewsLauncher(pi: ExtensionAPI): void {
  setViewSwitcher(VIEWS_SHORTCUT, switcher(pi))
  pi.registerCommand("cue:views", {
    description: "Pick a view to open",
    handler: async (_args, ctx) => openLauncher(pi, ctx),
  })
  pi.registerShortcut(VIEWS_SHORTCUT, {
    description: "Pick a view to open",
    handler: async (ctx) => openLauncher(pi, ctx),
  })
}
