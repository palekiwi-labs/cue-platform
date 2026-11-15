import { buildPacketFromDiff } from "./gen.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEMO_META = {
  repoPath: "/home/pl/nix-config",
  branch: "feat/agent-microvm",
  baseSha: "30a461ee956419b78d326e6466da7f187e8b6a81",
  headSha: "9d8a3972018f35241e0b80180c46c110185d2fd7",
  subject: "nvim: cue C-t and A-a also in insert mode",
};

export function demoPacketPath(): string {
  return join(homedir(), ".cache", "station", "demo.json");
}

export function buildDemo(now = Date.now()): string {
  const here = dirname(new URL(import.meta.url).pathname);
  const diff = readFileSync(join(here, "..", "demo", "demo.diff"), "utf8");
  const packet = buildPacketFromDiff(diff, { ...DEMO_META, now });
  const out = demoPacketPath();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(packet, null, 2) + "\n");
  return out;
}
