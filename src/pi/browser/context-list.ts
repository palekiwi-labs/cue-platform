/**
 * The context list shared by the cue browser and the PR review picker:
 * which rows show for a query and recency window, and how a row reads.
 */

import type { Theme } from "@earendil-works/pi-coding-agent"
import { fuzzyFilter, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { collapseTree, type ContextRow, filterRecent, relativeAge, sortFlatContexts, treePrefix } from "./model"

export const MODE_COLOR: Record<string, Parameters<Theme["fg"]>[0]> = {
  research: "accent",
  design: "warning",
  build: "success",
  review: "error",
  learn: "muted",
}

const pad = (s: string, w: number): string => truncateToWidth(s, w, "…", true)

/**
 * Pad or cut to `w` columns. Unlike truncateToWidth it emits no ANSI
 * reset when cutting, so a row's selection background survives.
 */
const clip = (s: string, w: number): string => {
  if (w <= 0) return ""
  const sw = visibleWidth(s)
  if (sw <= w) return s + " ".repeat(w - sw)
  return sliceByColumn(s, 0, w - 1, true) + "…"
}

/** Widest slug column a row of `width` gets: 40, or 45% of wide rows. */
const slugCap = (width: number): number => Math.max(40, Math.floor(width * 0.45))

/** The tree before folding: recent contexts (with ancestors), or all. */
export function treeRows(rows: ContextRow[], recent: boolean, now: number, days: number): ContextRow[] {
  return recent ? filterRecent(rows, now, days) : rows
}

/**
 * Rows to show: the folded tree, or with a query, fuzzy matches over the
 * same set — folded, old or not only when the recency window is off.
 * Ancestor-only scaffolding is dropped before matching; flat lists sort
 * by recency.
 */
export function shownContexts(
  rows: ContextRow[],
  query: string,
  tree: ContextRow[],
  collapsed: ReadonlySet<string>,
  flat = false,
): ContextRow[] {
  const candidates = tree.filter((r) => !r.ancestorOnly)
  if (query.trim() === "") {
    return flat
      ? sortFlatContexts(candidates)
      : collapseTree(tree, collapsed).rows
  }
  return fuzzyFilter(candidates, query, (r) => `${r.slug} ${r.title} ${r.scope}`)
}

/** Slug column width fitting `rows`, never below `min`; contextLine caps it to the row width. */
export function slugWidthFor(rows: ContextRow[], collapsed: ReadonlySet<string>, min: number): number {
  const widths = rows.map((r) =>
    visibleWidth(treePrefix(r) + r.slug) + (collapsed.has(r.address) ? 5 : 0))
  return Math.max(min, ...widths)
}

export interface ContextLineOpts {
  /** Draw tree connectors (no query). */
  tree: boolean
  /** The session's context, highlighted. */
  here: string | undefined
  /** A context marked with a dot in the pin column (e.g. a branch link). */
  marked?: string
  /** Rows span several scopes: show the scope in place of the title. */
  mixed: boolean
  /** Folded rows and how many descendants they hide. */
  hidden: ReadonlyMap<string, number>
  slugWidth: number
  now: number
  width: number
}

/** One context row: pin, tree and slug, age, mode, title. */
export function contextLine(t: Theme, r: ContextRow, o: ContextLineOpts): string {
  const pin = r.address === o.marked ? t.fg("accent", "●") : r.pinned ? t.fg("warning", "*") : " "
  // Cut the plain slug before styling: cutting styled text would reset
  // the selection background for the rest of the row.
  const slugW = Math.min(o.slugWidth, slugCap(o.width))
  const prefix = o.tree ? treePrefix(r) : ""
  const marker = o.hidden.has(r.address) ? ` +${o.hidden.get(r.address)}` : ""
  const room = slugW - visibleWidth(prefix) - visibleWidth(marker)
  const slug = visibleWidth(r.slug) > room ? clip(r.slug, room) : r.slug
  const styled = r.address === o.here ? t.fg("accent", slug) : r.ancestorOnly || r.archivedAt !== null ? t.fg("dim", slug) : slug
  const name = clip(t.fg("dim", prefix) + styled + t.fg("dim", marker), slugW)
  const mode = r.archivedAt !== null
    ? t.fg("dim", "ARCHIVED")
    : r.mode
    ? t.fg(MODE_COLOR[r.mode] ?? "muted", pad(r.mode.toUpperCase(), 8))
    : t.fg("dim", pad("—", 8))
  const age = t.fg("muted", relativeAge(r.lastLoggedAt, o.now).padStart(4))
  // Cross-repo lists show the scope in place of the title, as cue.nvim does.
  const rest = o.mixed ? t.fg("muted", r.scope) : t.fg("muted", r.title)
  return clip(`${pin} ${name} ${age} ${mode} ${rest}`, o.width)
}
