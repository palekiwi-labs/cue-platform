import { spawnSync } from "node:child_process";
import {
  type Component,
  KeybindingsManager,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  setKeybindings,
  TUI_KEYBINDINGS,
  TuiAltScreen,
} from "@earendil-works/pi-tui";
import { ChangesView, type ComposeRequest } from "./changes.js";
import { run } from "./git.js";
import { FindingsView, headInRepo, loadRun, loadSources } from "./findings.js";
import { LAUNCHES, type LaunchKind, launchPickerText, launchReview, launchWalkthrough } from "./launch.js";
import { PR_SORTS, PrsView, sortPickerText } from "./prs.js";
import { pruneReviews } from "./prune.js";
import { PrsSource } from "./prs-source.js";
import { backdrop, ComposeBox, Popup, type PopupContent, popupWidth } from "./popup.js";
import type { PacketFile } from "./packet.js";
import { preparerRun, submitToSupervisor } from "./prepare.js";
import { walkthroughSaveCommand } from "./walkthrough-save.js";
import { fromDemo, fromPr, fromRange, resolvePr, type PrSummary, prRepo, repoSlug, type Review } from "./source.js";
import { buildRound, osc52, reviewContext, type RoundComment, submitRound } from "./round.js";
import { loadComments, loadFolds, saveComments, saveFolds } from "./state.js";
import { findingsTab, type PrTabHost, walkthroughTab } from "./pr-tabs.js";
import { prContext } from "./pr-review.js";
import { TabsScreen } from "./tabs.js";
import { loadWalkthrough, loadWalkthroughSources, WalkthroughView } from "./walkthrough.js";

let contextOverride: string | null = null;

function usage(code: number): never {
  const out = code === 0 ? console.log : console.error;
  out("usage: station                  open pull requests (in a GitHub repo), else branch changes");
  out("       station prs              open pull requests of this repository");
  out("       station branch           changes on the current branch vs its base");
  out("       station pr <number>      changes of a GitHub pull request");
  out("       station <base>..<head>   changes in a commit range");
  out("       station clean            remove review worktrees of closed PRs");
  out("       station findings <run>   verified findings of a review run (<ctx address>/review/runs/<run_id>)");
  out("       station walkthrough <w>  guided walkthrough (<ctx address>/review/walkthrough/<id>.json)");
  out("       station demo             built-in demo diff");
  out("       station prepare-walkthrough <number> [--head <sha>] [--model <id>]");
  out("                                submit a walkthrough preparer run for a PR to the supervisor");
  out("       station walkthrough-save --repo <path> --pr <n> --base <sha> --head <sha> <file>");
  out("                                validate a walkthrough file and save it to review-pr-N");
  out("");
  out("  --context <slug>   cue context for submitted comment rounds of non-PR reviews (default review-<branch-slug>; PR reviews always use review-pr-N)");
  process.exit(code);
}

function currentHead(repoPath: string): string | null {
  try {
    return run(repoPath, ["rev-parse", "HEAD"]).trim();
  } catch {
    return null;
  }
}

function openEditor(
  tui: TuiAltScreen,
  repoPath: string,
  file: PacketFile,
  line: number,
  base?: string,
): void {
  openPath(tui, repoPath, file.status === "deleted" ? (file.old_path ?? file.path) : file.path, line, base);
}

function openPath(tui: TuiAltScreen, repoPath: string, path: string, line: number, base?: string): void {
  const editor = process.env.EDITOR ?? "nvim";
  const env = { ...process.env };
  if (base !== undefined && base !== "" && headInRepo(repoPath, base)) env.STATION_BASE = base;
  else delete env.STATION_BASE;
  tui.stop({ preserveScreen: true });
  spawnSync(editor, [`+${line}`, path], { cwd: repoPath, stdio: "inherit", env });
  tui.start();
  tui.requestRender(true);
}

function changesView(
  router: Router,
  review: Review,
  onQuit: () => void,
  quitLabel?: string,
): ChangesView {
  return new ChangesView({
    title: review.title,
    subtitle: review.subtitle,
    packet: review.packet,
    highlights: review.highlights,
    folds: loadFolds(review.key),
    comments: loadComments(review.key),
    headMatches: currentHead(review.repoPath) === review.packet.head_sha,
    onQuit,
    quitLabel,
    onFolds: (folds) => saveFolds(review.key, folds),
    onCopy: (text) => process.stdout.write(osc52(text)),
    onComments: (comments) => saveComments(review.key, comments),
    onCompose: (request, done) => router.compose(request, done),
    onOpen: (file, line) => openEditor(router.tui, review.repoPath, file, line, review.packet.base_sha),
    onSubmit: (comments, done) => void submit(router, review, comments, done),
  });
}

async function submit(router: Router, review: Review, comments: RoundComment[], done: (ok: boolean) => void): Promise<void> {
  const title = "submit comments";
  const fail = (text: string): void => router.showPopup({ title, text, error: true, footer: "any key" }, true);
  if (review.cueDir === null) {
    fail("this review has no repository to submit to");
    return;
  }
  let context: string;
  try {
    context = reviewContext(review.branch, review.pr, contextOverride);
  } catch (e) {
    fail(errText(e));
    return;
  }
  router.showPopup({ title, text: `writing ${comments.length} comment${comments.length === 1 ? "" : "s"} to ${context}…` });
  const target = { repo: review.repo, key: review.key, title: review.title, branch: review.branch, pr: review.pr };
  const round = buildRound(target, review.packet.base_sha, review.packet.head_sha, comments, Math.floor(Date.now() / 1000));
  try {
    const address = await submitRound(review.cueDir, context, round);
    done(true);
    router.showPopup(
      { title: "round submitted", text: address, footer: "y copy  any key close" },
      true,
      { y: () => process.stdout.write(osc52(address)) },
    );
  } catch (e) {
    done(false);
    fail(errText(e));
  }
}

interface Screen extends Component {
  handleInput(data: string): void;
  handleEscape?(): boolean;
}

class Router {
  readonly tui = new TuiAltScreen(new ProcessTerminal());
  private screen: Screen | null = null;
  private back: (() => void) | null = null;
  private popup: { handles: OverlayHandle[]; dismissable: boolean; keys: Record<string, () => void> } | null = null;
  private composing: { box: ComposeBox; handle: OverlayHandle; done: (text: string | null) => void } | null = null;

  constructor() {
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.altScreen.pageUp": [],
      "tui.altScreen.pageDown": [],
      "tui.altScreen.previousPrompt": [],
      "tui.altScreen.nextPrompt": [],
    }));
    this.tui.addInputListener((data) => {
      if (this.composing !== null) {
        if (data === "\x1b") this.endCompose(null);
        else this.composing.box.editor.handleInput(matchesKey(data, "alt+enter") ? "\n" : data);
      } else if (this.popup !== null) {
        const action = this.popup.keys[data];
        if (this.popup.dismissable) {
          this.hidePopup();
          action?.();
        } else if (data === "\x03") this.quit();
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

  showPopup(content: PopupContent, dismissable = false, keys: Record<string, () => void> = {}): void {
    this.hidePopup();
    const opts = { nonCapturing: true } as const;
    this.popup = {
      dismissable,
      keys,
      handles: [
        this.tui.showOverlay(backdrop, { ...opts, anchor: "top-left", width: "100%", maxHeight: "100%" }),
        this.tui.showOverlay(new Popup(content), { ...opts, anchor: "center", width: popupWidth() }),
      ],
    };
    this.tui.requestRender();
  }

  compose(request: ComposeRequest, done: (text: string | null) => void): void {
    const box = new ComposeBox(this.tui, request.title, request.text);
    box.editor.onSubmit = (text) => this.endCompose(text.trim() === "" ? null : text.trimEnd());
    const handle = this.tui.showOverlay(box, { nonCapturing: true, anchor: "bottom-center", width: "100%" });
    this.composing = { box, handle, done };
    this.tui.requestRender();
  }

  private endCompose(text: string | null): void {
    const c = this.composing;
    if (c === null) return;
    this.composing = null;
    c.handle.hide();
    c.done(text);
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

function prTabs(
  router: Router,
  review: Review,
  chosen: Map<string, string>,
  onQuit: () => void,
  quitLabel?: string,
): TabsScreen {
  const pr = review.pr;
  const repo = review.cueDir;
  if (pr === null || repo === null) throw new Error("not a pull request review");
  const host: PrTabHost = {
    repo,
    repoSlug: review.repo,
    pr,
    prHead: review.packet.head_sha,
    prWorktree: review.repoPath,
    chosen,
    onQuit,
    openPath: (cwd, path, line, base) => openPath(router.tui, cwd, path, line, base),
    showPopup: (content, dismissable, keys) => router.showPopup(content, dismissable, keys),
  };
  return new TabsScreen([
    { label: "changes", screen: () => changesView(router, review, onQuit, quitLabel) },
    { label: "findings", screen: () => findingsTab(host) },
    { label: "walkthrough", screen: () => walkthroughTab(host) },
  ]);
}

function showReview(review: Review): void {
  const router = new Router();
  const quit = (): void => router.quit();
  router.show(review.pr !== null ? prTabs(router, review, new Map(), quit) : changesView(router, review, quit));
  router.tui.start();
}

function showWalkthrough(address: string): void {
  const walkthrough = loadWalkthrough(address);
  const repoPath = process.cwd();
  if (!headInRepo(repoPath, walkthrough.head)) {
    throw new Error(`head ${walkthrough.head.slice(0, 10)} is not in this repository; run from a checkout of the reviewed repo (git fetch may help)`);
  }
  const router = new Router();
  router.show(new WalkthroughView({
    walkthrough,
    sources: loadWalkthroughSources(repoPath, walkthrough),
    subtitle: address,
    onQuit: () => router.quit(),
    onOpen: (rev, file, line) => {
      if (rev === walkthrough.head) openPath(router.tui, repoPath, file, line, walkthrough.base);
      else router.showPopup({ title: "open", text: `${file} is at ${rev.slice(0, 10)}, not the head; open it from station pr`, error: true, footer: "any key" }, true);
    },
  }));
  router.tui.start();
}

async function clean(): Promise<void> {
  const repo = prRepo(process.cwd());
  if (repo === null) throw new Error("not in a GitHub repository");
  const source = new PrsSource(repoSlug(repo).toLowerCase());
  let prs: PrSummary[];
  try {
    const data = await source.load(true);
    if (!data.healthy) throw new Error(`refusing to prune: ${data.note}`);
    prs = data.prs;
  } finally {
    await source.client.close();
  }
  const r = await pruneReviews(repo, new Set(prs.map((p) => p.number)));
  for (const n of r.removed) console.log(`removed #${n}`);
  for (const n of r.kept) console.log(`kept #${n} (uncommitted changes)`);
  if (r.removed.length + r.kept.length === 0) console.log("nothing to clean");
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function showPrs(repo: string): void {
  const router = new Router();
  let busy = false;
  const source = new PrsSource(repoSlug(repo).toLowerCase());
  let revision = "";
  let loading = false;
  let checking = false;
  const refresh = async (live = true): Promise<void> => {
    if (loading) return;
    loading = true;
    list.setNote(live ? "refreshing through GitHub service…" : "loading snapshot…");
    router.tui.requestRender();
    try {
      const data = await source.load(live);
      revision = data.revision;
      list.setPrs(data.prs, data.viewer);
      list.setNote(data.note);
    } catch (e) {
      list.setNote(`GitHub service: ${errText(e)}`);
    } finally {
      loading = false;
      router.tui.requestRender();
    }
  };
  const unwatch = source.client.watch(() => {
    if (loading || checking || !revision) return;
    checking = true;
    void source.load().then((data) => {
      if (data.revision !== revision) list.setNote("new PR data available · r refresh");
    }).catch((e) => list.setNote(`GitHub service: ${errText(e)}`)).finally(() => {
      checking = false;
      router.tui.requestRender();
    });
  });
  const toList = (): void => router.show(list);
  const chosen = new Map<string, string>();
  const open = async (pr: PrSummary): Promise<void> => {
    if (busy) return;
    busy = true;
    router.showPopup({ title: `#${pr.number}`, text: `fetching ${pr.title}…`, footer: "ctrl+c quit" });
    try {
      const review = await fromPr(repo, String(pr.number));
      router.hidePopup();
      router.show(prTabs(router, review, chosen, toList, "back"), toList);
    } catch (e) {
      router.showPopup({ title: `#${pr.number}`, text: errText(e), error: true, footer: "any key" }, true);
    } finally {
      busy = false;
    }
  };
  const launch = async (pr: PrSummary, kind: LaunchKind): Promise<void> => {
    if (busy) return;
    busy = true;
    const title = `${kind} #${pr.number}`;
    router.showPopup({ title, text: `launching ${kind} for ${pr.title}…`, footer: "ctrl+c quit" });
    try {
      const station = [process.execPath, process.argv[1] ?? "station"];
      const text = kind === "review" ? await launchReview(repo, pr.number) : await launchWalkthrough(repo, pr.number, station);
      router.showPopup({ title, text, footer: "any key" }, true);
    } catch (e) {
      router.showPopup({ title, text: errText(e), error: true, footer: "any key" }, true);
    } finally {
      busy = false;
    }
  };
  const list = new PrsView({
    repo: repoSlug(repo),
    onQuit: () => {
      unwatch();
      void source.client.close().finally(() => router.quit());
    },
    onOpen: (pr) => void open(pr),
    onLaunch: (pr) =>
      router.showPopup(
        { title: `launch #${pr.number}`, text: launchPickerText(), footer: "any other key cancel" },
        true,
        Object.fromEntries(LAUNCHES.map((l) => [l.key, () => void launch(pr, l.kind)])),
      ),
    onRefresh: () => void refresh(),
    onCopy: (text) => process.stdout.write(osc52(text)),
    onPickSort: (current, choose) =>
      router.showPopup(
        { title: "sort", text: sortPickerText(current), footer: "any other key cancel" },
        true,
        Object.fromEntries(PR_SORTS.map((s) => [s.key, () => choose(s.sort)])),
      ),
  });
  router.show(list);
  router.tui.start();
  void refresh(false);
}

function showFindings(address: string): void {
  const findingsRun = loadRun(address);
  const repoPath = process.cwd();
  if (!headInRepo(repoPath, findingsRun.head)) {
    throw new Error(`head ${findingsRun.head.slice(0, 10)} is not in this repository; run from a checkout of the reviewed repo (git fetch may help)`);
  }
  const files = findingsRun.findings.flatMap((f) => (f.file === null ? [] : [f.file]));
  const router = new Router();
  router.show(new FindingsView({ run: findingsRun, sources: loadSources(repoPath, findingsRun.head, files),
    onQuit: () => router.quit(),
    onOpen: (file, line) => openPath(router.tui, repoPath, file, line, findingsRun.base),
  }));
  router.tui.start();
}

type Target = Review | { prs: string } | { findings: string } | { walkthrough: string };

async function resolve(args: string[]): Promise<Target> {
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
  if (cmd === "clean" && arg === undefined) {
    await clean();
    process.exit(0);
  }
  if (cmd === "demo" && arg === undefined) return fromDemo();
  if (cmd === "findings" && arg !== undefined) return { findings: arg };
  if (cmd === "walkthrough" && arg !== undefined) return { walkthrough: arg };
  if (cmd === "pr" && arg !== undefined && /^\d+$/.test(arg)) return fromPr(process.cwd(), arg);
  if (cmd.includes("..") && arg === undefined) return fromRange(process.cwd(), cmd);
  usage(2);
}

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("-")) usage(2);
  args.splice(i, 2);
  return value;
}

async function prepareWalkthrough(args: string[]): Promise<void> {
  const head = takeFlag(args, "--head");
  const model = takeFlag(args, "--model");
  const [number, extra] = args;
  if (number === undefined || extra !== undefined || !/^\d+$/.test(number)) usage(2);
  const pr = await resolvePr(process.cwd(), number, head);
  const station = [process.execPath, process.argv[1] ?? "station"];
  const { batchId, runIds } = await submitToSupervisor([preparerRun(station, pr, model)]);
  console.log(`submitted walkthrough for #${pr.number} at ${pr.headSha.slice(0, 12)}`);
  console.log(`batch ${batchId}  run ${runIds.join(" ")}`);
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "walkthrough-save" || args[0] === "prepare-walkthrough") {
    try {
      if (args[0] === "walkthrough-save") process.exit(await walkthroughSaveCommand(args.slice(1)));
      await prepareWalkthrough(args.slice(1));
      process.exit(0);
    } catch (e) {
      console.error(`station: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }
  const flag = args.indexOf("--context");
  if (flag !== -1) {
    const value = args[flag + 1];
    if (value === undefined || value.startsWith("-")) usage(2);
    contextOverride = value;
    args.splice(flag, 2);
  }
  if (args[0] === "--help" || args[0] === "-h") usage(0);
  let target: Target;
  try {
    target = await resolve(args);
    if (contextOverride !== null && ("prs" in target || ("pr" in target && target.pr !== null))) {
      throw new Error("--context is not allowed for PR reviews; rounds go to review-pr-N");
    }
    if ("findings" in target) {
      showFindings(target.findings);
      return;
    }
    if ("walkthrough" in target) {
      showWalkthrough(target.walkthrough);
      return;
    }
  } catch (e) {
    console.error(`station: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if ("prs" in target) showPrs(target.prs);
  else showReview(target);
}
