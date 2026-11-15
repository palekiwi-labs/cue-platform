import { spawnSync } from "node:child_process";
import { type Component, type OverlayHandle, ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { ChangesView } from "./changes.js";
import { run, spawnAsync } from "./git.js";
import { PrsView } from "./prs.js";
import { backdrop, Popup, type PopupContent, popupWidth } from "./popup.js";
import type { PacketFile } from "./packet.js";
import { fromDemo, fromPr, fromRange, listPrs, type PrSummary, prRepo, repoSlug, type Review } from "./source.js";
import { loadFolds, saveFolds } from "./state.js";

function usage(code: number): never {
  const out = code === 0 ? console.log : console.error;
  out("usage: station                  open pull requests (in a GitHub repo), else branch changes");
  out("       station prs              open pull requests of this repository");
  out("       station branch           changes on the current branch vs its base");
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

function changesView(
  tui: TuiAltScreen,
  review: Review,
  onQuit: () => void,
  quitLabel?: string,
): ChangesView {
  return new ChangesView({
    title: review.title,
    subtitle: review.subtitle,
    packet: review.packet,
    folds: loadFolds(review.key),
    headMatches: currentHead(review.repoPath) === review.packet.head_sha,
    onQuit,
    quitLabel,
    onFolds: (folds) => saveFolds(review.key, folds),
    onOpen: (file, line) => openEditor(tui, review.repoPath, file, line),
  });
}

interface Screen extends Component {
  handleInput(data: string): void;
  handleEscape?(): boolean;
}

class Router {
  readonly tui = new TuiAltScreen(new ProcessTerminal());
  private screen: Screen | null = null;
  private back: (() => void) | null = null;
  private popup: { handles: OverlayHandle[]; dismissable: boolean } | null = null;

  constructor() {
    this.tui.addInputListener((data) => {
      if (this.popup !== null) {
        if (this.popup.dismissable) this.hidePopup();
        else if (data === "\x03") this.quit();
      } else if (data === "\x1b") {
        if (this.screen?.handleEscape?.() !== true) this.back?.();
      } else this.screen?.handleInput(data);
      this.tui.requestRender();
      return { consume: true };
    });
    process.stdout.on("resize", () => this.tui.requestRender(true));
  }

  show(screen: Screen, back: (() => void) | null = null): void {
    if (this.screen !== null) this.tui.removeChild(this.screen);
    this.screen = screen;
    this.back = back;
    this.tui.addChild(screen);
    this.tui.requestRender(true);
  }

  showPopup(content: PopupContent, dismissable = false): void {
    this.hidePopup();
    const opts = { nonCapturing: true } as const;
    this.popup = {
      dismissable,
      handles: [
        this.tui.showOverlay(backdrop, { ...opts, anchor: "top-left", width: "100%", maxHeight: "100%" }),
        this.tui.showOverlay(new Popup(content), { ...opts, anchor: "center", width: popupWidth() }),
      ],
    };
    this.tui.requestRender();
  }

  hidePopup(): void {
    for (const h of this.popup?.handles ?? []) h.hide();
    this.popup = null;
    this.tui.requestRender();
  }

  quit(): never {
    this.tui.stop({ preserveScreen: true });
    process.exit(0);
  }
}

function showReview(review: Review): void {
  const router = new Router();
  router.show(changesView(router.tui, review, () => router.quit()));
  router.tui.start();
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function ghLogin(repo: string): Promise<string> {
  try {
    return (await spawnAsync("gh", ["api", "user", "--jq", ".login"], repo)).trim();
  } catch {
    return "";
  }
}

function showPrs(repo: string): void {
  const router = new Router();
  let busy = false;
  let me = "";
  const refresh = async (): Promise<void> => {
    router.showPopup({ title: "pull requests", text: "loading…", footer: "ctrl+c quit" });
    try {
      const [prs, login] = await Promise.all([listPrs(repo), me === "" ? ghLogin(repo) : Promise.resolve(me)]);
      me = login;
      list.setPrs(prs, me);
      router.hidePopup();
    } catch (e) {
      router.showPopup({ title: "pull requests", text: errText(e), error: true, footer: "any key" }, true);
    }
    router.tui.requestRender();
  };
  const toList = (): void => router.show(list);
  const open = async (pr: PrSummary): Promise<void> => {
    if (busy) return;
    busy = true;
    router.showPopup({ title: `#${pr.number}`, text: `fetching ${pr.title}…`, footer: "ctrl+c quit" });
    try {
      const review = await fromPr(repo, String(pr.number));
      router.hidePopup();
      router.show(changesView(router.tui, review, toList, "back"), toList);
    } catch (e) {
      router.showPopup({ title: `#${pr.number}`, text: errText(e), error: true, footer: "any key" }, true);
    } finally {
      busy = false;
    }
  };
  const list = new PrsView({
    repo: repoSlug(repo),
    onQuit: () => router.quit(),
    onOpen: (pr) => void open(pr),
    onRefresh: () => void refresh(),
  });
  router.show(list);
  router.tui.start();
  void refresh();
}

async function resolve(args: string[]): Promise<Review | { prs: string }> {
  const [cmd, arg, extra] = args;
  if (extra !== undefined) usage(2);
  if (cmd === undefined) {
    const repo = prRepo(process.cwd());
    return repo !== null ? { prs: repo } : fromRange(process.cwd(), undefined);
  }
  if (cmd === "branch" && arg === undefined) return fromRange(process.cwd(), undefined);
  if (cmd === "prs" && arg === undefined) {
    const repo = prRepo(process.cwd());
    if (repo === null) throw new Error("not in a GitHub repository");
    return { prs: repo };
  }
  if (cmd === "demo" && arg === undefined) return fromDemo();
  if (cmd === "pr" && arg !== undefined && /^\d+$/.test(arg)) return fromPr(process.cwd(), arg);
  if (cmd.includes("..") && arg === undefined) return fromRange(process.cwd(), cmd);
  usage(2);
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") usage(0);
  let target: Review | { prs: string };
  try {
    target = await resolve(args);
  } catch (e) {
    console.error(`station: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if ("prs" in target) showPrs(target.prs);
  else showReview(target);
}
