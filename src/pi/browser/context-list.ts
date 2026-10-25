/**
 * The context list shared by the cue browser and the PR review picker:
 * which rows show for a query and recency window, and how a row reads.
 */

import type { Theme } from "@earendil-works/pi-coding-agent"
import { fuzzyFilter, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { collapseTree, type ContextRow, filterRecent, relativeAge, treePrefix } from "./model"

export const MODE_COLOR: Record<string, Parameters<Theme["fg"]>[0]> = {
  research: "accent",
  design: "warning",
  build: "success",
  review: "error",
  learn: "muted",
}

const pad = (s: string, w: number): string => truncateToWidth(s, w, "…", true)

/** The tree before folding: recent contexts (with ancestors), or all. */
export function treeRows(rows: ContextRow[], recent: boolean, now: number, days: number): ContextRow[] {
  return recent ? filterRecent(rows, now, days) : rows
}

/**
 * Rows to show: the folded tree, or with a query, fuzzy matches over the
 * whole list, folded, old or not.
 */
export function shownContexts(
  rows: ContextRow[],
  query: string,
  tree: ContextRow[],
  collapsed: ReadonlySet<string>,
  flat = false,
): ContextRow[] {
  if (query.trim() === "") {
    return flat ? tree.filter((r) => !r.ancestorOnly) : collapseTree(tree, collapsed).rows
  }
  return fuzzyFilter(rows, query, (r) => `${r.slug} ${r.title} ${r.scope}`)
}

/** Slug column width fitting `rows`, never below `min`, at most 40. */
export function slugWidthFor(rows: ContextRow[], collapsed: ReadonlySet<string>, min: number): number {
  const widths = rows.map((r) =>
    visibleWidth(treePrefix(r) + r.slug) + (collapsed.has(r.address) ? 5 : 0))
  return Math.min(40, Math.max(min, ...widths))
}

export interface ContextLineOpts {
  /** Draw tree connectors (no query). */
  tree: boolean
  /** The session's context, highlighted. */
  here: string | undefined
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
  const pin = r.pinned ? t.fg("warning", "*") : " "
  const name = (o.tree ? t.fg("dim", treePrefix(r)) : "") +
    (r.address === o.here ? t.fg("accent", r.slug) : r.ancestorOnly || r.archivedAt !== null ? t.fg("dim", r.slug) : r.slug) +
    (o.hidden.has(r.address) ? t.fg("dim", ` +${o.hidden.get(r.address)}`) : "")
  const mode = r.archivedAt !== null
    ? t.fg("dim", "ARCHIVED")
    : r.mode
    ? t.fg(MODE_COLOR[r.mode] ?? "muted", pad(r.mode.toUpperCase(), 8))
    : t.fg("dim", pad("—", 8))
  const age = t.fg("muted", relativeAge(r.lastLoggedAt, o.now).padStart(4))
  // Cross-repo lists show the scope in place of the title, as cue.nvim does.
  const rest = o.mixed ? t.fg("muted", r.scope) : t.fg("muted", r.title)
  return pad(`${pin} ${pad(name, o.slugWidth)} ${age} ${mode} ${rest}`, o.width)
}
