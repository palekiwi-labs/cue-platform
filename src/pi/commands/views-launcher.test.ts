import { describe, expect, test } from "bun:test"
import { menuWidth, ViewMenu, VIEWS } from "./views-launcher"

const plain = { fg: (_c: unknown, s: string) => s, bold: (s: string) => s }

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

  test("renders a box with each view, without shortcuts", () => {
    const menu = new ViewMenu(plain, VIEWS)
    const lines = menu.render(menuWidth(VIEWS))
    expect(lines[0]).toStartWith("╭─ views ")
    expect(lines[1]).toMatch(/^│ > contexts +│$/)
    expect(lines[5]).toMatch(/^│   GitHub PRs +│$/)
    expect(lines.at(-1)).toContain("esc close")
  })

  test("selection wraps around both ends", () => {
    const menu = new ViewMenu(plain, VIEWS)
    menu.move(-1)
    expect(menu.current()?.label).toBe("agent monitor")
    menu.move(1)
    expect(menu.current()?.label).toBe("contexts")
  })
})
