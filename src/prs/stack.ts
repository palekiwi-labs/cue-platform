export interface StackRefs {
  baseRef: string
  headRef: string
  defaultBranch: string
}

/**
 * PRs of one repository as a stacked tree, depth-first. Roots target the
 * default branch or a branch no listed PR heads; children target a parent's
 * head. Roots and siblings are ordered by `compare`. Every PR appears once:
 * a visited set stops cycles, and PRs reachable only through a cycle are
 * listed at the top level.
 */
export function stackPrs<T extends StackRefs>(
  prs: readonly T[],
  compare: (a: T, b: T) => number,
): { pr: T; depth: number }[] {
  const heads = new Set(prs.map((p) => p.headRef))
  const byBase = new Map<string, T[]>()
  for (const p of prs) byBase.set(p.baseRef, [...(byBase.get(p.baseRef) ?? []), p])
  const out: { pr: T; depth: number }[] = []
  const seen = new Set<T>()
  const walk = (p: T, depth: number) => {
    if (seen.has(p)) return
    seen.add(p)
    out.push({ pr: p, depth })
    for (const c of [...(byBase.get(p.headRef) ?? [])].sort(compare)) walk(c, depth + 1)
  }
  const roots = prs.filter((p) => p.baseRef === p.defaultBranch || !heads.has(p.baseRef))
  for (const r of [...roots].sort(compare)) walk(r, 0)
  for (const p of [...prs].sort(compare)) walk(p, 0)
  return out
}
