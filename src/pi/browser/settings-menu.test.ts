import { describe, expect, test } from "bun:test"
import { type Setting, SettingsForm } from "./settings-menu"

const theme = { fg: (_c: any, s: string) => s, bold: (s: string) => s }
const kb = { matches: () => false } as any

function setting(label: string, group: Setting["group"], values: string[], current: number, log: string[]): Setting {
  return { label, group, values, current, apply: (i) => log.push(`${label}=${values[i]}`) }
}

describe("SettingsForm", () => {
  test("lists filter rows before display rows", () => {
    const log: string[] = []
    const form = new SettingsForm(theme, kb, "t", [
      setting("preview", "display", ["off", "on"], 1, log),
      setting("scope", "filter", ["all", "repo"], 0, log),
    ], () => {})
    const lines = form.render(40).join("\n")
    expect(lines.indexOf("scope")).toBeLessThan(lines.indexOf("preview"))
  })

  test("applies only changed values, and only on apply", () => {
    const log: string[] = []
    const form = new SettingsForm(theme, kb, "t", [
      setting("scope", "filter", ["all", "repo"], 0, log),
      setting("recency", "filter", ["1d", "7d", "30d"], 1, log),
    ], () => {})
    form.step(1)
    form.moveRow(1)
    form.step(1)
    form.step(-1)
    expect(log).toEqual([])
    form.apply()
    expect(log).toEqual(["scope=repo"])
  })

  test("values wrap", () => {
    const log: string[] = []
    const form = new SettingsForm(theme, kb, "t", [setting("recency", "filter", ["1d", "7d", "30d"], 0, log)], () => {})
    form.step(-1)
    form.apply()
    expect(log).toEqual(["recency=30d"])
  })
})
