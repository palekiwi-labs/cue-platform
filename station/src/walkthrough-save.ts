import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catFiles, run, spawnAsync } from "./git.js";
import { ensureContext } from "./round.js";
import { checkWalkthroughV2, codeRefs, sourceKey, type Walkthrough } from "./walkthrough.js";

export interface Pinned {
  pr: number;
  base: string;
  head: string;
}

function lineCount(text: string): number {
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/** Checks the walkthrough against the pinned PR revision and the blobs each code ref points at. */
export function checkRefs(
  w: Walkthrough,
  pinned: Pinned,
  commitExists: (sha: string) => boolean,
  blobs: Map<string, string | null>,
): string[] {
  const errors: string[] = [];
  if (w.pr !== pinned.pr) errors.push(`$.pr: must be ${pinned.pr}`);
  if (w.base !== "" && w.base !== pinned.base) errors.push(`$.base: must be the pinned merge-base ${pinned.base}`);
  if (w.head !== "" && w.head !== pinned.head) errors.push(`$.head: must be the pinned head ${pinned.head}`);
  w.chunks.forEach((c, i) =>
    c.sections.forEach((s, j) =>
      s.steps.forEach((st, k) => {
        const code = st.code;
        if (code === null) return;
        const where = `$.chunks[${i}].sections[${j}].steps[${k}].code`;
        if (!commitExists(code.rev)) {
          errors.push(`${where}.rev: commit ${code.rev} is not in the repository`);
          return;
        }
        const blob = blobs.get(sourceKey(code)) ?? null;
        if (blob === null) {
          errors.push(`${where}.path: no file ${code.path} at ${code.rev}`);
          return;
        }
        if (code.lines === null) return;
        const count = lineCount(blob);
        if (code.lines[1] > count) {
          errors.push(`${where}.lines: [${code.lines[0]}, ${code.lines[1]}] is past the end of ${code.path} (${count} lines) at ${code.rev}`);
        }
      }),
    ),
  );
  return errors;
}

/** Validates a walkthrough file fully against the repository and returns every error found. */
export function validateWalkthroughFile(repo: string, file: string, pinned: Pinned): { walkthrough: Walkthrough | null; errors: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { walkthrough: null, errors: [`$: not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { walkthrough: null, errors: ["$: must be a JSON object"] };
  }
  const obj = data as Record<string, unknown>;
  const errors: string[] = [];
  if (obj.version !== 2) errors.push("$.version: must be 2");
  const checked = checkWalkthroughV2("", obj);
  errors.push(...checked.errors);
  const w = checked.walkthrough;
  const keys = [...new Set(codeRefs(w).map(sourceKey))];
  const blobs = catFiles(repo, keys);
  const sources = new Map(keys.map((k, i) => [k, blobs[i] ?? null]));
  const commitExists = (sha: string): boolean => {
    try {
      run(repo, ["cat-file", "-e", `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };
  errors.push(...checkRefs(w, pinned, commitExists, sources));
  return { walkthrough: w, errors };
}

export function walkthroughName(now: number): string {
  return `walkthrough/agent-${now}.json`;
}

/** Writes a validated walkthrough file into review-pr-N and returns its canonical address. */
export async function saveWalkthrough(repo: string, file: string, pr: number, now: number): Promise<string> {
  const context = `review-pr-${pr}`;
  const address = await ensureContext(repo, context, `Review PR #${pr}`);
  const name = walkthroughName(now);
  const tmp = mkdtempSync(join(tmpdir(), "station-walkthrough-"));
  try {
    const copy = join(tmp, "walkthrough.json");
    writeFileSync(copy, readFileSync(file, "utf8"));
    await spawnAsync("cue", ["add", "-t", "review", "-C", repo, "--context", context, name, "--file", copy], repo);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return `${address}/review/${name}`;
}

function flag(args: string[], name: string): string {
  const i = args.indexOf(name);
  const value = i === -1 ? undefined : args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing ${name}`);
  args.splice(i, 2);
  return value;
}

/** `station walkthrough-save --repo <path> --pr <n> --base <sha> --head <sha> <file>`; returns the exit code. */
export async function walkthroughSaveCommand(argv: string[]): Promise<number> {
  const args = [...argv];
  let repo: string;
  let pinned: Pinned;
  try {
    repo = flag(args, "--repo");
    const pr = Number(flag(args, "--pr"));
    if (!Number.isInteger(pr) || pr <= 0) throw new Error("--pr must be a positive integer");
    pinned = { pr, base: flag(args, "--base"), head: flag(args, "--head") };
    if (args.length !== 1) throw new Error("expected exactly one walkthrough file");
  } catch (e) {
    console.error(`station walkthrough-save: ${e instanceof Error ? e.message : String(e)}`);
    console.error("usage: station walkthrough-save --repo <path> --pr <n> --base <sha> --head <sha> <file>");
    return 2;
  }
  const file = args[0] as string;
  const { errors } = validateWalkthroughFile(repo, file, pinned);
  if (errors.length > 0) {
    console.log(`not saved: ${errors.length} error${errors.length === 1 ? "" : "s"}`);
    for (const e of errors) console.log(e);
    return 1;
  }
  const address = await saveWalkthrough(repo, file, pinned.pr, Math.floor(Date.now() / 1000));
  console.log(`saved ${address}`);
  return 0;
}
