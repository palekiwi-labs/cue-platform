import type { PopupContent } from "./popup.js";
import { FindingsView, headInRepo, loadRun, loadSources } from "./findings.js";
import { findingsWorktree, listRuns, prContext, type RunEntry } from "./pr-review.js";
import { NoticeView, type TabScreen } from "./tabs.js";

const PICK_KEYS = "abcdefghijklmnorstuvwxyz";

export interface FindingsTabHost {
  repo: string;
  repoSlug: string;
  pr: number;
  prHead: string;
  prWorktree: string;
  chosen: Map<number, string>;
  onQuit: () => void;
  openPath: (cwd: string, path: string, line: number) => void;
  showPopup: (content: PopupContent, dismissable: boolean, keys?: Record<string, () => void>) => void;
}

export function runPickerText(runs: RunEntry[]): string {
  return runs
    .slice(0, PICK_KEYS.length)
    .map((r, i) => `${PICK_KEYS[i]}  ${r.runId}  head ${r.head.slice(0, 10)}  ${r.verified ? "verified" : r.state}`)
    .join("\n");
}

export class FindingsTab implements TabScreen {
  private inner: TabScreen;

  constructor(private readonly host: FindingsTabHost) {
    this.inner = this.notice([]);
    const runs = listRuns(host.repoSlug, host.pr);
    const remembered = host.chosen.get(host.pr);
    if (remembered !== undefined && runs.some((r) => r.address === remembered)) this.load(remembered);
    else if (runs.length === 1) this.load(runs[0]!.address);
    else this.pick(runs);
  }

  private notice(body: string[]): TabScreen {
    return new NoticeView({
      title: `findings  #${this.host.pr}`,
      subtitle: prContext(this.host.repoSlug, this.host.pr),
      body,
      onQuit: this.host.onQuit,
    });
  }

  private pick(runs = listRuns(this.host.repoSlug, this.host.pr)): void {
    const where = `${prContext(this.host.repoSlug, this.host.pr)}/review/runs/`;
    if (runs.length === 0) {
      this.inner = this.notice([`no review runs in ${where}`]);
      return;
    }
    if (!(this.inner instanceof FindingsView)) this.inner = this.notice(["no run chosen", "", "p pick a run"]);
    const keys = Object.fromEntries(
      runs.slice(0, PICK_KEYS.length).map((r, i) => [PICK_KEYS[i]!, () => this.load(r.address)]),
    );
    this.host.showPopup({ title: "review run", text: runPickerText(runs), footer: "any other key cancel" }, true, keys);
  }

  private load(address: string): void {
    try {
      const run = loadRun(address);
      if (!headInRepo(this.host.repo, run.head)) {
        throw new Error(`head ${run.head.slice(0, 10)} is not in this repository (git fetch may help)`);
      }
      const files = run.findings.flatMap((f) => (f.file === null ? [] : [f.file]));
      this.host.chosen.set(this.host.pr, address);
      this.inner = new FindingsView({
        run,
        sources: loadSources(this.host.repo, run.head, files),
        onQuit: this.host.onQuit,
        onOpen: (file, line) => void this.open(run.head, file, line),
      });
    } catch (e) {
      this.inner = this.notice([e instanceof Error ? e.message : String(e), "", "p pick a run"]);
    }
  }

  private async open(head: string, file: string, line: number): Promise<void> {
    try {
      const cwd = head === this.host.prHead ? this.host.prWorktree : await findingsWorktree(this.host.repo, this.host.pr, head);
      this.host.openPath(cwd, file, line);
    } catch (e) {
      this.host.showPopup({ title: "open", text: e instanceof Error ? e.message : String(e), error: true, footer: "any key" }, true);
    }
  }

  invalidate(): void {
    this.inner.invalidate?.();
  }

  handleInput(data: string): void {
    if (data === "p") this.pick();
    else this.inner.handleInput(data);
  }

  handleEscape(): boolean {
    return this.inner.handleEscape?.() === true;
  }

  render(width: number): string[] {
    return this.inner.render(width);
  }
}
