import { describe, expect, test } from "bun:test"
import { ActionMenu, menuColumns } from "./action-menu"
import type { Binding } from "./keymap"

const run = () => {}
const b = (label: string, menu?: Binding["menu"]): Binding => ({ keys: ["ctrl+x"], label, group: "act", menu, run })

const theme = { fg: (_c: any, s: string) => s, bold: (s: string) => s }
const kb = { matches: () => false } as any

describe("menuColumns", () => {
  test("keeps section order and drops untagged bindings and empty sections", () => {
    const cols = menuColumns([b("pin", "act"), b("up"), b("copy", "copy"), b("open", "open")])
    expect(cols.map((c) => c.section)).toEqual(["open", "act", "copy"])
    expect(cols.map((c) => c.rows.map((r) => r.label))).toEqual([["open"], ["pin"], ["copy"]])
  })
})

describe("ActionMenu", () => {
  const menu = () => new ActionMenu(theme, kb, "t", [b("a", "open"), b("b", "open"), b("c", "act")], () => {})

  test("moving columns clamps the row to the shorter column", () => {
    const m = menu()
    m.moveRow(1)
    m.moveCol(1)
    expect(m.current()?.label).toBe("c")
  })

  test("rows and columns wrap", () => {
    const m = menu()
    m.moveRow(-1)
    expect(m.current()?.label).toBe("b")
    m.moveCol(-1)
    expect(m.current()?.label).toBe("c")
  })
})
