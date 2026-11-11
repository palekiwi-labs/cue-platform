import { describe, expect, test } from "bun:test"
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import type { Component, TUI } from "@earendil-works/pi-tui"
import { setViewSwitcher, withViewSwitch } from "./view-switch"

const F1 = "\x1bOP"

class FakeView implements Component {
  seen: string[] = []
  focused = false
  render(_width: number): string[] {
    return ["view"]
  }
  invalidate(): void {}
  handleInput(data: string): void {
    this.seen.push(data)
  }
}

const none = {} as unknown

describe("withViewSwitch", () => {
  test("the switch key opens the switcher instead of reaching the view", () => {
    let closes = 0
    let switched = 0
    setViewSwitcher("f1", (_ctx, _tui, _theme, _kb, close) => {
      switched++
      close()
    })
    const view = new FakeView()
    const wrapped = withViewSwitch(
      view,
      none as ExtensionContext,
      none as TUI,
      none as Theme,
      none as KeybindingsManager,
      () => closes++,
    )
    wrapped.handleInput!(F1)
    wrapped.handleInput!("j")
    expect(switched).toBe(1)
    expect(closes).toBe(1)
    expect(view.seen).toEqual(["j"])
  })

  test("other properties pass through to the view", () => {
    const view = new FakeView()
    const wrapped = withViewSwitch(
      view,
      none as ExtensionContext,
      none as TUI,
      none as Theme,
      none as KeybindingsManager,
      () => {},
    )
    wrapped.focused = true
    expect(view.focused).toBe(true)
    expect(wrapped.render(10)).toEqual(["view"])
  })
})
