import { spawn, spawnSync } from "node:child_process";

export function run(cwd: string, args: string[]): string {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr ?? "").trim()}`);
  }
  return res.stdout;
}

export function spawnAsync(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} ${args.join(" ")} failed: ${err.trim()}`));
    });
  });
}

export function runAsync(cwd: string, args: string[]): Promise<string> {
  return spawnAsync("git", ["-C", cwd, ...args], cwd);
}
