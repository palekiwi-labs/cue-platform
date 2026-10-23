import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { DynamicBorder } from "@earendil-works/pi-coding-agent"
import {
  Container,
  fuzzyFilter,
  Input,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui"

const MAX_VISIBLE = 12

/**
 * Narrow items by a fuzzy query, preserving the input order when the
 * query is empty (callers pass items pre-sorted, e.g. by recency).
 */
export function fuzzyNarrow(items: string[], query: string): string[] {
  return fuzzyFilter(items, query, (s) => s)
}

/**
 * A picker item. `value` is what the picker resolves; `text` is what
 * the query fuzzy-matches (default: value). `label` (e.g. a
 * tree-indented slug) is shown only while the query is empty, since a
 * filtered list breaks the structure it draws; `flat` replaces it in
 * the filtered view (default: `text`). `right` is a muted meta column
 * (e.g. the context's scope), aligned across rows in both views.
 */
export interface PickItem {
  value: string
  text?: string
  label?: string
  flat?: string
  right?: string
}

/**
 * How a pick was submitted: `submit` is enter; `alt` is the alternative
 * submit key (ALT_SUBMIT_KEY), offered only when the caller names it.
 */
export type PickAction = "submit" | "alt"

export interface Picked {
  value: string
  action: PickAction
}

/** Alternative submit key for fuzzySelect. */
export const ALT_SUBMIT_KEY = "alt+enter"

export interface FuzzySelectOptions {
  /** Footer hint for the alternative submit; enables ALT_SUBMIT_KEY. */
  altHint?: string
  /** Footer hint for enter (default: "select"). */
  submitHint?: string
}

/**
 * Like `ui.select`, with a type-to-filter fuzzy query line. Arrow keys
 * and enter/escape drive the list; every other key edits the query.
 * Resolves the chosen item and how it was submitted, or undefined on
 * cancel.
 */
export async function fuzzySelect(
  ui: ExtensionUIContext,
  title: string,
  items: readonly (string | PickItem)[],
  opts: FuzzySelectOptions = {},
): Promise<Picked | undefined> {
  const picks: PickItem[] = items.map((i) =>
    typeof i === "string" ? { value: i } : i,
  )
  /** Left-column width so `right` meta aligns across rows. */
  const leftWidth = Math.max(
    0,
    ...picks.map((p) => (p.label ?? p.text ?? p.value).length),
  )

  const picked = await ui.custom<Picked | null>((tui, theme, kb, done) => {
    const listTheme = {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    }
    const input = new Input()
    input.focused = true
    const holder = new Container()
    let list!: SelectList

    const rebuild = () => {
      const query = input.getValue()
      const textOf = (p: PickItem) => p.text ?? p.value
      const shown = fuzzyFilter(picks, query, textOf)
      const plain = (query.trim() === "")
      const entries: SelectItem[] = shown.map((p) => {
        const left = plain
          ? (p.label ?? textOf(p))
          : (p.flat ?? textOf(p))
        const label = p.right
          ? left.padEnd(leftWidth + 2) + theme.fg("muted", p.right)
          : left
        return { value: p.value, label }
      })
      list = new SelectList(entries, MAX_VISIBLE, listTheme)
      list.onSelect = (item) => done({ value: item.value, action: "submit" })
      list.onCancel = () => done(null)
      holder.clear()
      holder.addChild(list)
    }
    rebuild()

    const footer = [
      "type to filter",
      "↑↓ navigate",
      `enter ${opts.submitHint ?? "select"}`,
      ...(opts.altHint ? [`${ALT_SUBMIT_KEY} ${opts.altHint}`] : []),
      "esc cancel",
    ].join(" • ")
    const container = new Container()
    const border = () => new DynamicBorder((s: string) => theme.fg("accent", s))
    container.addChild(border())
    container.addChild(new Text(theme.fg("accent", theme.bold(title))))
    container.addChild(input)
    container.addChild(holder)
    container.addChild(
      new Text(theme.fg("dim", footer)),
    )
    container.addChild(border())

    const listKeys = [
      "tui.select.up",
      "tui.select.down",
      "tui.select.pageUp",
      "tui.select.pageDown",
      "tui.select.confirm",
      "tui.select.cancel",
    ] as const

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        if (opts.altHint && matchesKey(data, ALT_SUBMIT_KEY)) {
          const item = list.getSelectedItem()
          if (item) done({ value: item.value, action: "alt" })
          return
        }
        if (listKeys.some((k) => kb.matches(data, k))) {
          list.handleInput(data)
        } else {
          const before = input.getValue()
          input.handleInput(data)
          if (input.getValue() !== before) rebuild()
        }
        tui.requestRender()
      },
    }
  })
  return picked ?? undefined
}
