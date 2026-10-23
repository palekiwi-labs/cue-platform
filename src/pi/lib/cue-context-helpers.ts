/**
 * Build the argv tail for `cue context create` from tool args.
 *
 * Every value is emitted as its own argv entry, so prose fields carrying
 * quotes, backticks or newlines never reach a shell parser.
 *
 * Blank strings are dropped rather than forwarded: an empty `--title` would
 * write an empty presentation field into the context record, which reads as a
 * deliberate blank rather than as an absent one.
 *
 * `kind` is emitted only when given; cue defaults it to `work`.
 *
 * Kept pure for unit testing.
 */
export function contextCreateFlags(args: {
  title?: string
  kind?: string
  mode?: string
  description?: string
  parent?: string
  refs?: string[]
}): string[] {
  const flags: string[] = []
  const push = (flag: string, value: string | undefined) => {
    const trimmed = value?.trim()
    if (trimmed) {
      flags.push(flag, trimmed)
    }
  }

  push("--title", args.title)
  push("--kind", args.kind)
  push("--mode", args.mode)
  push("--description", args.description)
  push("--parent", args.parent)

  for (const ref of args.refs ?? []) {
    push("--ref", ref)
  }

  return flags
}
