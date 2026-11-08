import { describe, expect, test } from "bun:test"
import { launcherItems, VIEWS } from "./views-launcher"

describe("views launcher", () => {
  test("lists the views in a fixed order", () => {
    expect(VIEWS.map((v) => v.label)).toEqual([
      "contexts",
      "artifacts",
      "sessions",
      "activity",
      "GitHub PRs",
      "agent monitor",
    ])
  })

  test("shows each view's shortcut", () => {
    expect(launcherItems(VIEWS)).toEqual([
      { value: "contexts", right: "ctrl+t" },
      { value: "artifacts", right: "alt+a" },
      { value: "sessions", right: "ctrl+r" },
      { value: "activity", right: "ctrl+a" },
      { value: "GitHub PRs", right: "alt+p" },
      { value: "agent monitor", right: "alt+m" },
    ])
  })
})
