import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { type Component, type KeyId, matchesKey, type TUI } from "@earendil-works/pi-tui"

/**
 * Shows the views menu over an open view; `close` closes that view
 * before the picked one opens.
 */
export type ViewSwitcher = (
  ctx: ExtensionContext,
  tui: TUI,
  theme: Theme,
  kb: KeybindingsManager,
  close: () => void,
) => void

let switcher: ViewSwitcher | undefined
let switchKey: KeyId | undefined

/** Install the switcher and the key that triggers it inside views. */
export function setViewSwitcher(key: KeyId, s: ViewSwitcher): void {
  switchKey = key
  switcher = s
}

/**
 * Wrap a view so the switch key opens the views menu over it; every
 * other property and key passes through to the view unchanged.
 */
export function withViewSwitch<C extends Component>(
  view: C,
  ctx: ExtensionContext,
  tui: TUI,
  theme: Theme,
  kb: KeybindingsManager,
  close: () => void,
): C {
  return new Proxy(view, {
    get(target, prop, receiver) {
      if (prop !== "handleInput") return Reflect.get(target, prop, receiver)
      return (data: string) => {
        if (switcher && switchKey && matchesKey(data, switchKey)) {
          return switcher(ctx, tui, theme, kb, close)
        }
        return target.handleInput?.(data)
      }
    },
  })
}
