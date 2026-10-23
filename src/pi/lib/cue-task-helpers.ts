/**
 * Build the task frontmatter object from tool args.
 *
 * `status` defaults to "open", matching cue's own write path: a task is
 * created deliberately with a defined goal, so it is triaged by the act of
 * being written. Captured ideas that genuinely await triage are notes, not
 * tasks; `inbox` is not a status the model defines.
 *
 * There is no `kind`: it describes what ends a container of work, which is a
 * property of the context, not of a task. A context may hold several tasks
 * sharing one log, spec and plan.
 *
 * Kept pure for unit testing.
 */
export function taskFrontmatter(args: {
  title: string
  status?: string
  priority?: string
  parent?: string
  refs?: string[]
}): Record<string, string | string[]> {
  const fm: Record<string, string | string[]> = {
    title: args.title,
    status: args.status ?? "open",
    priority: args.priority ?? "normal",
    refs: args.refs ?? [],
  }
  if (args.parent) {
    fm.parent = args.parent
  }
  return fm
}
