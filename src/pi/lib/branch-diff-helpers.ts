/**
 * Pure helpers for save-branch-diff: branch-name flattening, artifact
 * filename derivation, and the offline base-branch hierarchy.
 */

/**
 * Flatten a git branch name into a single path segment suitable as a cue
 * artifact filename. Branch names may contain "/" (e.g. "feat/foo") which
 * cue rejects as a multi-segment filename, and a leading "-" would be
 * misparsed as a CLI flag by clap. Runs of unsafe characters collapse into
 * a single dash; leading/trailing separators are stripped.
 */
export function sanitizeBranchName(branch: string): string {
  return branch
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-._]+/, "")
    .replace(/[-._]+$/, "")
}

/**
 * Artifact filename for a saved diff, derived from the sanitized branch
 * name so different branches keep separate files. An unknown branch
 * (detached HEAD) falls back to "branch".
 */
export function diffFilename(branch: string): string {
  const name = sanitizeBranchName(branch) || "branch"
  return `${name}.diff`
}

/**
 * Offline base-branch hierarchy: the git-pr-sync-written
 * `branch.<name>.base` config key, then origin/HEAD, then "master".
 * Blank values are treated as absent.
 */
export function resolveBase(
  configBase?: string,
  remoteHeadRef?: string,
): string {
  if (configBase?.trim()) {
    return configBase.trim()
  }
  if (remoteHeadRef?.trim().startsWith("origin/")) {
    return remoteHeadRef.trim().slice("origin/".length)
  }
  return "master"
}
