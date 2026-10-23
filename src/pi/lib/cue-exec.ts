import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Build the message an agent sees when a cue invocation fails.
 *
 * cue prints its diagnostic to stderr ("Error: ..."). Without this, the
 * thrown message would be a bare exit code and agents would misdiagnose
 * deterministic failures as flaky. This puts cue's own text into the thrown
 * message, names the subcommand, and names the directory cue ran in — the
 * scope cue resolved is derived from it, so a context lookup in the wrong
 * repository's scope becomes readable instead of mysterious.
 */
export function cueFailureMessage(
  argv: string[],
  cwd: string,
  code: number,
  stderr: string,
  stdout: string,
): string {
  const command = argv.slice(0, 2).join(" ")
  const diagnostic = stderr.trim() || stdout.trim() || `exit code ${code}`
  return `cue ${command} failed in ${cwd}: ${diagnostic}`
}

/**
 * Run `cue <argv>` in cwd via pi.exec and return trimmed stdout.
 *
 * pi.exec passes argv natively (no shell), so arguments containing spaces
 * or metacharacters are safe. Throws an Error whose message carries cue's
 * own diagnostic on any non-zero exit.
 */
export async function runCue(
  pi: ExtensionAPI,
  argv: string[],
  cwd: string,
): Promise<string> {
  const result = await pi.exec("cue", argv, { cwd })
  if (result.code !== 0) {
    throw new Error(
      cueFailureMessage(argv, cwd, result.code, result.stderr, result.stdout),
    )
  }
  return result.stdout.trim()
}
