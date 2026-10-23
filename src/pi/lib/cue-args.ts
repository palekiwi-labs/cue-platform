import { isAbsolute, resolve } from "node:path"
import { homedir } from "node:os"

/**
 * Build the `--dir` flag from a user-supplied directory.
 *
 * "~" expands to the home directory and relative paths resolve against the
 * session directory (ctx.cwd). An absent directory emits nothing, leaving
 * cue to run in the session directory.
 *
 * `--dir` selects the *repository*, never the store: scope is derived from
 * that repository's `origin` remote, so pointing at a sibling project reads
 * and writes that project's scope inside the same central store.
 */
export function dirFlag(dir: string | undefined, cwd: string): string[] {
  if (!dir?.trim()) {
    return []
  }
  let expanded = dir.trim()
  if (expanded.startsWith("~/") || expanded === "~") {
    expanded = homedir() + expanded.slice(1)
  }
  if (isAbsolute(expanded)) {
    return ["--dir", expanded]
  }
  return ["--dir", resolve(cwd, expanded)]
}

/**
 * Build the `--context` flag.
 *
 * Every agent-side call passes context explicitly. cue's own resolution
 * chain ends in *unset*, where writes fail rather than guess, and the
 * branch-local `branch.<name>.cue-context` association belongs to the
 * operator: an agent that let context resolve implicitly would inherit
 * whatever the operator happened to have checked out.
 */
export function contextFlag(context: string | undefined): string[] {
  const slug = context?.trim()
  return slug ? ["--context", slug] : []
}

/**
 * Build the `--store` flag.
 *
 * Normally absent: the store root comes from `$CUE_STORE`, exported by the
 * devshell. This exists for the case of addressing a store that is not the
 * ambient one, such as a read-only archive of a pre-migration store.
 */
export function storeFlag(store: string | undefined): string[] {
  const root = store?.trim()
  if (!root) {
    return []
  }
  if (root.startsWith("~/") || root === "~") {
    return ["--store", homedir() + root.slice(1)]
  }
  return ["--store", root]
}
