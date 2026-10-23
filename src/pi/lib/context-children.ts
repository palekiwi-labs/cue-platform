import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * TypeScript port of `commands/opencode/cue/scripts/context-children.sh`:
 * resolve the active (or specified) context's canonical address via
 * `cue status --json`, then list its direct children across the whole
 * store. Returns the wrapped `<children>` block, or an empty string when
 * the address is absent, the list fails, or the list is empty — the block
 * is omitted entirely, exactly like the script.
 */
export async function contextChildren(
  pi: ExtensionAPI,
  cwd: string,
  contextSlug?: string,
): Promise<string> {
  let address = ""
  try {
    const statusArgs = contextSlug
      ? ["status", "--context", contextSlug, "--json"]
      : ["status", "--json"]
    const status = await pi.exec("cue", statusArgs, { cwd })
    if (status.code === 0) {
      const parsed = JSON.parse(status.stdout || "{}") as { address?: string }
      address = parsed.address ?? ""
    }
  } catch {
    address = ""
  }
  if (!address) return ""

  let children = ""
  try {
    const listed = await pi.exec(
      "cue",
      ["context", "list", "--scope", "store", "--filter", `parent=${address}`],
      { cwd },
    )
    if (listed.code === 0) children = listed.stdout.trim()
  } catch {
    children = ""
  }
  if (!children) return ""

  return `<children>\n${children}\n</children>`
}
