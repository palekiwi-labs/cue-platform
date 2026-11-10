import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { Component, TUI } from "@earendil-works/pi-tui"
import { ActionMenu, actionMenuWidth, ACTIONS_KEY } from "../browser/action-menu"
import type { Binding } from "../browser/keymap"
import { type Setting, SETTINGS_KEY, SettingsForm, settingsWidth } from "../browser/settings-menu"
import { activeStyle, listStyles, setActiveStyle } from "../response-style"

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const

type ThinkingLevel = (typeof THINKING_LEVELS)[number]

const NEW_SESSION_COMMAND = "cue:new-session"
const RELOAD_COMMAND = "cue:reload"

/** Run one of this extension's commands with a command context. */
function runCommand(pi: ExtensionAPI, command: string): void {
  void pi.sendUserMessage(`/${command}`, { expandPromptTemplates: true })
}

const action = (label: string, menu: Binding["menu"], run: () => void): Binding => ({
  keys: [],
  label,
  group: "act",
  menu,
  run,
})

/** Actions on the session and the pi instance, as F2 lists them. */
export function sessionActions(pi: ExtensionAPI, ctx: ExtensionContext): Binding[] {
  return [
    action("interrupt", "act", () => ctx.abort()),
    action("rename", "act", async () => {
      const name = (await ctx.ui.input("Session name", pi.getSessionName()))?.trim()
      if (name) pi.setSessionName(name)
    }),
    action("label", "act", async () => {
      const label = (await ctx.ui.input("Label", "todo, important, ..."))?.trim()
      if (label) runCommand(pi, `label ${label}`)
    }),
    action("new session", "open", () => runCommand(pi, NEW_SESSION_COMMAND)),
    action("reload", "view", () => runCommand(pi, RELOAD_COMMAND)),
    action("quit", "view", () => ctx.shutdown()),
  ]
}

/** Settings of the session, as F3 lists them. */
export function sessionSettings(pi: ExtensionAPI): Setting[] {
  const level = pi.getThinkingLevel() as ThinkingLevel
  const styles = listStyles()
  return [
    {
      label: "thinking",
      group: "display",
      values: [...THINKING_LEVELS],
      current: Math.max(0, THINKING_LEVELS.indexOf(level)),
      apply: (i) => pi.setThinkingLevel(THINKING_LEVELS[i]!),
    },
    {
      label: "style",
      group: "display",
      values: styles,
      current: Math.max(0, styles.indexOf(activeStyle())),
      apply: (i) => setActiveStyle(styles[i]!),
    },
  ]
}

function redrawing(tui: TUI, inner: Component & { handleInput(data: string): void }): Component {
  return {
    render: (w) => inner.render(w),
    invalidate: () => inner.invalidate(),
    handleInput: (data) => {
      inner.handleInput(data)
      tui.requestRender()
    },
  }
}

async function openActions(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return
  const bindings = sessionActions(pi, ctx)
  const title = "actions: session"
  const picked = await ctx.ui.custom<Binding | null>(
    (tui, theme, kb, done) => redrawing(tui, new ActionMenu(theme, kb, title, bindings, done)),
    { overlay: true, overlayOptions: { anchor: "center", width: actionMenuWidth(bindings, title) } },
  )
  picked?.run?.()
}

async function openSettings(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return
  const settings = sessionSettings(pi)
  const title = "settings: session"
  await ctx.ui.custom<boolean>(
    (tui, theme, kb, done) => redrawing(tui, new SettingsForm(theme, kb, title, settings, done)),
    { overlay: true, overlayOptions: { anchor: "center", width: settingsWidth(settings, title) } },
  )
}

/** F2 session actions and F3 session settings in pi's main view. */
export function registerSessionMenus(pi: ExtensionAPI): void {
  pi.registerCommand(NEW_SESSION_COMMAND, {
    description: "Start a new session",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      await ctx.newSession()
    },
  })
  pi.registerCommand(RELOAD_COMMAND, {
    description: "Reload extensions, skills, prompts and themes",
    handler: async (_args, ctx: ExtensionCommandContext) => ctx.reload(),
  })
  pi.registerShortcut(ACTIONS_KEY, {
    description: "Session actions",
    handler: async (ctx) => openActions(pi, ctx),
  })
  pi.registerShortcut(SETTINGS_KEY, {
    description: "Session settings",
    handler: async (ctx) => openSettings(pi, ctx),
  })
}
