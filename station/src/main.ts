import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { buildDemo } from "./demo.js";
import { buildPacket } from "./gen.js";
import { run } from "./git.js";
import { emptyState, loadPacket, loadState, type Packet, type PacketChunk, type PacketState } from "./packet.js";
import { ChunkNavView } from "./view.js";

function usage(): never {
  console.error("usage: station gen <repo> <base>..<head> [out.json]");
  console.error("       station <packet.json>");
  console.error("       station            (demo packet)");
  process.exit(2);
}

function statePath(packetPath: string): string {
  return packetPath.replace(/\.json$/, "") + ".state.json";
}

function persistState(path: string, state: PacketState): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}

function gen(repo: string, range: string, outArg: string | undefined): void {
  const packet = buildPacket(resolve(repo), range);
  const out = outArg ?? `${packet.id}.json`;
  writeFileSync(out, JSON.stringify(packet, null, 2) + "\n");
  console.error(`packet ${packet.id}: ${packet.files.length} files, ${packet.chunks.length} chunks -> ${out}`);
}

function currentHead(repoPath: string): string | null {
  try {
    return run(repoPath, ["rev-parse", "HEAD"]).trim();
  } catch {
    return null;
  }
}

function openEditor(tui: TuiAltScreen, packet: Packet, chunk: PacketChunk): void {
  const file = packet.files.find((f) => f.id === chunk.file_id);
  if (file === undefined) return;
  const editor = process.env.EDITOR ?? "nvim";
  const line = chunk.new_start > 0 ? `+${chunk.new_start}` : "+1";
  const path = file.status === "deleted" ? (file.old_path ?? file.path) : file.path;
  tui.stop();
  spawnSync(editor, [line, path], { cwd: packet.repo_path, stdio: "inherit" });
  tui.start();
}

function review(packetPath: string): void {
  const packet = loadPacket(readFileSync(packetPath, "utf8"));
  const sp = statePath(packetPath);
  let stateText: string | null = null;
  try {
    stateText = readFileSync(sp, "utf8");
  } catch {
    stateText = null;
  }
  const state = loadState(stateText, packet.id);
  const headMatches = currentHead(packet.repo_path) === packet.head_sha;

  const tui = new TuiAltScreen(new ProcessTerminal());
  const view = new ChunkNavView({
    packet,
    state,
    headMatches,
    onQuit: () => {
      clearInterval(keepalive);
      process.exit(0);
    },
    onPersist: (s) => persistState(sp, s),
    onOpen: (chunk) => openEditor(tui, packet, chunk),
  });
  tui.addChild(view);
  const keepalive = setInterval(() => tui.requestRender(), 30_000);
  tui.addInputListener((data) => {
    view.handleInput(data);
    tui.requestRender();
    return { consume: true };
  });
  tui.requestRender();
}

export function main(): void {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === "--help" || cmd === "-h") usage();
  if (cmd === "gen") {
    if (a === undefined || b === undefined) usage();
    gen(a, b, c);
    return;
  }
  if (cmd === undefined) {
    review(buildDemo());
    return;
  }
  if (a !== undefined) usage();
  try {
    review(cmd);
  } catch (e) {
    console.error(`cannot open packet ${cmd}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export { emptyState };
