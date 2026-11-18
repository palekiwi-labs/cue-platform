import { spawnAsync } from "./git.js";
import { preparerRun, submitToSupervisor } from "./prepare.js";
import { resolvePr } from "./source.js";

export type LaunchKind = "review" | "walkthrough";

export const LAUNCHES: readonly { kind: LaunchKind; key: string; label: string }[] = [
  { kind: "review", key: "r", label: "review run (cue-review, default manifest)" },
  { kind: "walkthrough", key: "w", label: "walkthrough (preparer agent)" },
];

export function launchPickerText(): string {
  return LAUNCHES.map((l) => `${l.key}  ${l.label}`).join("\n");
}

export function reviewArgs(repo: string, number: number): string[] {
  return ["pr", String(number), "--manifest", "default", "-C", repo];
}

export async function launchReview(repo: string, number: number): Promise<string> {
  const out = await spawnAsync("cue-review", reviewArgs(repo, number), repo);
  const last = out.trim().split("\n").filter(Boolean).pop() ?? "";
  return `review of #${number} started in review-pr-${number}${last ? `\n${last}` : ""}`;
}

export async function launchWalkthrough(repo: string, number: number, station: string[]): Promise<string> {
  const pr = await resolvePr(repo, String(number));
  const { runIds } = await submitToSupervisor([preparerRun(station, pr)]);
  return `walkthrough of #${number} at ${pr.headSha.slice(0, 12)} submitted\nrun ${runIds.join(" ")}`;
}
