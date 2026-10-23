import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Resolved git review context.
 */
export interface GitContext {
  baseBranch: string
  currentBranch: string
  mergeBase: string
}

/**
 * Determine git context for code reviews and PRs.
 *
 * Faithful TypeScript port of `commands/opencode/cue/scripts/git-context.sh`.
 * Uses `pi.exec` (no shell) so it carries no bash/pathing dependency. All
 * commands are best-effort; missing values return empty strings.
 */
export async function gitContext(
  pi: ExtensionAPI,
  cwd: string,
): Promise<GitContext> {
  const git = async (args: string[]): Promise<string> => {
    const r = await pi.exec("git", args, { cwd })
    return r.code === 0 ? r.stdout.trim() : ""
  }

  const refExists = async (ref: string): Promise<boolean> => {
    const r = await pi.exec(
      "git",
      ["show-ref", "--verify", "--quiet", ref],
      { cwd },
    )
    return r.code === 0
  }

  // 1. Determine current branch.
  const currentBranch =
    (await git(["symbolic-ref", "--quiet", "--short", "HEAD"])) ||
    (await git(["branch", "--show-current"]))

  // 2. Determine base branch via offline hierarchy (<5ms).
  let baseBranch = ""
  if (currentBranch) {
    baseBranch = await git(["config", `branch.${currentBranch}.base`])
  }
  if (!baseBranch) {
    const remoteHead = await git([
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ])
    if (remoteHead.startsWith("origin/")) {
      baseBranch = remoteHead.replace(/^origin\//, "")
    }
  }
  if (!baseBranch) {
    if (
      (await refExists("refs/heads/main")) ||
      (await refExists("refs/remotes/origin/main"))
    ) {
      baseBranch = "main"
    } else if (
      (await refExists("refs/heads/master")) ||
      (await refExists("refs/remotes/origin/master"))
    ) {
      baseBranch = "master"
    } else {
      baseBranch = "master"
    }
  }

  // 3. Determine merge base.
  let mergeBase = ""
  if (currentBranch && baseBranch) {
    mergeBase = await git(["merge-base", baseBranch, currentBranch])
  }

  return { baseBranch, currentBranch, mergeBase }
}

/**
 * Render the git context as the same three `KEY=VALUE` lines the opencode
 * `git-context.sh` prints, for injection into the init orientation message.
 */
export function formatGitContext(ctx: GitContext): string {
  return [
    `BASE_BRANCH=${ctx.baseBranch}`,
    `CURRENT_BRANCH=${ctx.currentBranch}`,
    `MERGE_BASE=${ctx.mergeBase}`,
  ].join("\n")
}
