import { spawnSync } from "node:child_process";

export function run(cwd: string, args: string[]): string {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr ?? "").trim()}`);
  }
  return res.stdout;
}
