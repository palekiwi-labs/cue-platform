/**
 * Flatten `cue context tree --json` output into pickable rows.
 *
 * The CLI builds the parent-child forest (subtree-recency ordering,
 * dangling parents as roots, cycle handling); this module only walks
 * the nested JSON once, recording each node's depth and box-drawing
 * connectors. Malformed nodes are dropped with their subtrees.
 */

export interface TreeEntry {
  address: string
  slug: string
  depth: number
  /** One flag per ancestor level below the root: does it have more siblings. */
  connectors: boolean[]
  isLast: boolean
}

interface RawNode {
  context?: unknown
  scope?: unknown
  children?: unknown
}

export function parseTree(stdout: string): TreeEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout || "{}")
  } catch {
    return []
  }
  const roots = (parsed as { roots?: unknown })?.roots
  if (!Array.isArray(roots)) return []

  const out: TreeEntry[] = []
  const visit = (
    node: unknown,
    depth: number,
    connectors: boolean[],
    isLast: boolean,
  ): void => {
    const n = node as RawNode
    if (typeof n?.context !== "string" || typeof n?.scope !== "string") return
    out.push({
      slug: n.context,
      address: `${n.scope}/${n.context}`,
      depth,
      connectors,
      isLast,
    })
    // Roots render flush left: their siblings are other trees, not a rail.
    const next = depth > 0 ? [...connectors, !isLast] : [...connectors]
    const kids = Array.isArray(n.children) ? n.children : []
    kids.forEach((kid, i) =>
      visit(kid, depth + 1, next, i === kids.length - 1),
    )
  }
  roots.forEach((r, i) => visit(r, 0, [], i === roots.length - 1))
  return out
}

/** Connector cell: "│ "/"  " per ancestor level, then "├─"/"└─"; "" for roots. */
export function treePrefix(entry: TreeEntry): string {
  if (entry.depth === 0) return ""
  let out = ""
  for (let i = 0; i < entry.depth - 1; i++)
    out += entry.connectors[i] ? "│ " : "  "
  return out + (entry.isLast ? "└─" : "├─")
}
