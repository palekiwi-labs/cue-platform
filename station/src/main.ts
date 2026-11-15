import { spawnSync } from "node:child_process";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { ChangesView } from "./changes.js";
import { run } from "./git.js";
import type { PacketFile } from "./packet.js";
import { fromDemo, fromPr, fromRange, type Review } from "./source.js";
import { loadFolds, saveFolds } from "./state.js";

function usage(code: number): never {
  const out = code === 0 ? console.log : console.error;
  out("usage: station                  changes on the current branch vs its base");
  out("       station pr <number>      changes of a GitHub pull request");
  out("       station <base>..<head>   changes in a commit range");
  out("       station demo             built-in demo diff");
  process.exit(code);
}

function currentHead(repoPath: string): string | null {
  try {
    return run(repoPath, ["rev-parse", "HEAD"]).trim();
  } catch {
    return null;
  }
}

function openEditor(tui: TuiAltScreen, repoPath: string, file: PacketFile, line: number): void {
  const editor = process.env.EDITOR ?? "nvim";
  const path = file.status === "deleted" ? (file.old_path ?? file.path) : file.path;
  tui.stop({ preserveScreen: true });
  spawnSync(editor, [`+${line}`, path], { cwd: repoPath, stdio: "inherit" });
  tui.start();
  tui.requestRender(true);
}

function show(review: Review): void {
  const tui = new TuiAltScreen(new ProcessTerminal());
  const view = new ChangesView({
    title: review.title,
    subtitle: review.subtitle,
    packet: review.packet,
    folds: loadFolds(review.key),
    headMatches: currentHead(review.repoPath) === review.packet.head_sha,
    onQuit: () => {
      tui.stop({ preserveScreen: true });
      process.exit(0);
    },
    onFolds: (folds) => saveFolds(review.key, folds),
    onOpen: (file, line) => openEditor(tui, review.repoPath, file, line),
  });
  tui.addChild(view);
  tui.addInputListener((data) => {
    view.handleInput(data);
    tui.requestRender();
    return { consume: true };
  });
  process.stdout.on("resize", () => tui.requestRender(true));
  tui.start();
}

function resolve(args: string[]): Review {
  const [cmd, arg, extra] = args;
  if (extra !== undefined) usage(2);
  if (cmd === undefined) return fromRange(process.cwd(), undefined);
  if (cmd === "demo" && arg === undefined) return fromDemo();
  if (cmd === "pr" && arg !== undefined && /^\d+$/.test(arg)) return fromPr(process.cwd(), arg);
  if (cmd.includes("..") && arg === undefined) return fromRange(process.cwd(), cmd);
  usage(2);
}

export function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") usage(0);
  let review: Review;
  try {
    review = resolve(args);
  } catch (e) {
    console.error(`station: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  show(review);
}
