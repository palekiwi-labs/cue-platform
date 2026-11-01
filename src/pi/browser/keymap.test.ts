import { describe, expect, test } from "bun:test"
import { type Binding, findBinding, HELP_KEYS, hintText, KeyHelp, layoutHelp } from "./keymap"

const b = (keys: Binding["keys"], label: string, group: Binding["group"], extra: Partial<Binding> = {}): Binding => ({
  keys,
  label,
  group,
  run: () => {},
  ...extra,
})

describe("findBinding", () => {
  test("first matching binding wins", () => {
    const first = b(["ctrl+h"], "copy link", "copy")
    const second = b(["ctrl+h"], "copy address", "copy")
    expect(findBinding([first, second], "\x08")?.label).toBe("copy link")
  })

  test("help keys match legacy 0x1f", () => {
    const help = b(HELP_KEYS, "keys", "view")
    expect(findBinding([help], "\x1f")).toBe(help)
  })

  test("ignores display-only rows", () => {
    expect(findBinding([b(["enter"], "open", "act", { run: undefined })], "\r")).toBeUndefined()
  })
})

describe("hintText", () => {
  test("lists only hint bindings, display name first", () => {
    const text = hintText([
      b(["escape"], "back", "navigate", { display: "esc", hint: true }),
      b(["ctrl+y"], "copy path", "copy"),
      b(HELP_KEYS, "keys", "view", { hint: true }),
    ])
    expect(text).toBe("esc back • ctrl+/ keys")
  })
})

describe("layoutHelp", () => {
  const rows = [
    b(["up"], "up", "navigate"),
    b(["enter"], "open", "act"),
    b(["alt+p"], "preview", "view"),
    b(["ctrl+y"], "copy path", "copy"),
  ]

  test("one column when narrow, groups in order", () => {
    const { columns } = layoutHelp(rows, 10)
    expect(columns.length).toBe(1)
    expect(columns[0]!.map((x) => x.group)).toEqual(["navigate", "act", "view", "copy"])
  })

  test("spreads groups over columns when wide", () => {
    expect(layoutHelp(rows, 200).columns.length).toBe(4)
  })
})

describe("KeyHelp", () => {
  const theme = { fg: (_c: any, s: string) => s, bold: (s: string) => s }

  test("renders a framed list and closes on help key", () => {
    let closed = false
    const help = new KeyHelp(theme, "keys: sessions", [b(["enter"], "resume", "act")], () => { closed = true }, () => 20)
    const lines = help.render(40)
    expect(lines[0]).toContain("keys: sessions")
    expect(lines.some((l) => l.includes("enter") && l.includes("resume"))).toBe(true)
    expect(lines.every((l) => l.length <= 40)).toBe(true)
    help.handleInput("\x1f")
    expect(closed).toBe(true)
  })
})
