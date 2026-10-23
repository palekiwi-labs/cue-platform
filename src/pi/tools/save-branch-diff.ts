import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { isAbsolute, resolve } from "node:path"
import { homedir } from "node:os"
import { Type } from "typebox"
import { diffFilename, resolveBase } from "../lib/branch-diff-helpers"
import { runCue } from "../lib/cue-exec"
import { withTempFile } from "../lib/temp"

const parameters = Type.Object({
  context: Type.String({
    description:
      "Context slug to save the diff under, within the repository's scope. " +
      "Required: cue has no default or fallback context and a write with " +
      "none fails.",
  }),
  dir: Type.Optional(
    Type.String({
      description:
        "Directory whose branch should be diffed. Defaults to the session " +
        "directory. Relative paths resolve against the session directory; " +
        "~ expands to the home directory.",
    }),
  ),
})

/**
 * Resolve the user-supplied directory against the session directory,
 * expanding "~" like the dir flag of the other cue tools. Returns null
 * when no directory was given (use the session directory as-is).
 */
function resolveTargetDir(
  dir: string | undefined,
  sessionDir: string,
): string | null {
  if (!dir?.trim()) {
    return null
  }
  let expanded = dir.trim()
  if (expanded.startsWith("~/") || expanded === "~") {
    expanded = homedir() + expanded.slice(1)
  }
  if (isAbsolute(expanded)) {
    return expanded
  }
  return resolve(sessionDir, expanded)
}

/**
 * Run git in cwd via pi.exec: argv is passed natively (no shell), so branch
 * names containing "/" are safe as arguments. Never throws; callers decide
 * whether a non-zero exit is meaningful. Stdout/stderr are captured.
 */
async function runGit(
  pi: ExtensionAPI,
  argv: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await pi.exec("git", argv, { cwd })
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

/** git stdout trimmed to empty on any non-zero exit (absence = ""). */
async function gitText(
  pi: ExtensionAPI,
  argv: string[],
  cwd: string,
): Promise<string> {
  const { code, stdout } = await runGit(pi, argv, cwd)
  return code === 0 ? stdout.trim() : ""
}

export function saveBranchDiffTool(pi: ExtensionAPI): ToolDefinition<typeof parameters> {
  return {
    name: "save-branch-diff",
    label: "save branch diff",
    description:
      "Generate a diff of the current feature branch against its base " +
      "branch and save it to cue as a tmp artifact named after the branch. " +
      "Defaults to the session directory; pass dir to target another " +
      "worktree of the repository.",
    parameters,
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      // 1. Pick the git tree to operate on
      const targetDir = resolveTargetDir(args.dir, ctx.cwd) ?? ctx.cwd

      // 2. Current branch (empty string on detached HEAD)
      const branch = await gitText(pi, ["branch", "--show-current"], targetDir)

      // 3. Resolve the base branch offline
      const configBase = branch
        ? await gitText(pi, ["config", `branch.${branch}.base`], targetDir)
        : ""
      const remoteHeadRef = await gitText(
        pi,
        ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        targetDir,
      )
      const base = resolveBase(configBase, remoteHeadRef)

      // 4. Generate the diff (a bad base is a real error; surface git's stderr)
      const head = await gitText(pi, ["rev-parse", "HEAD"], targetDir)
      const diff = await runGit(pi, ["diff", `${base}...HEAD`], targetDir)
      if (diff.code !== 0) {
        throw new Error(`git diff ${base}...HEAD failed: ${diff.stderr.trim()}`)
      }
      const diffContent = diff.stdout

      if (!diffContent.trim()) {
        return {
          content: [{ type: "text", text: `No diff between ${base} and ${head}` }],
          details: { status: "no_changes", branch, base, commit: head },
        }
      }

      // 5. Save to cue via a temp file (content never hits a shell); context
      //    is passed explicitly rather than resolved from the operator's
      //    branch association.
      //
      //    The diff stays a `tmp` artifact rather than becoming a `trace`,
      //    even though it is an artifact about a revision: cue prepends
      //    YAML frontmatter to every named artifact, which would corrupt
      //    the patch. tmp writes into a fresh tmp/<created_at>-<commit_hash>/
      //    directory, so captures separate across commits by the hash
      //    component and reruns at one commit accumulate rather than
      //    overwrite.
      const filename = diffFilename(branch)
      const output = await withTempFile(diffContent, "branch-diff", "diff", async (tempPath) =>
        runCue(
          pi,
          ["add", "--type", "tmp", "--context", args.context, "--file", tempPath, filename],
          targetDir,
        ),
      )

      return {
        content: [{ type: "text", text: `${output}\nReviewed commit: ${head}` }],
        details: { status: "success", branch, base, commit: head },
      }
    },
  }
}
