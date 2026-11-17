import type { PopupContent } from "./popup.js";
import { FindingsView, headInRepo, loadRun, loadSources } from "./findings.js";
import { findingsWorktree, listRuns, prContext, type RunEntry } from "./pr-review.js";
import { NoticeView, type TabScreen } from "./tabs.js";
import {
  listWalkthroughs,
  loadWalkthrough,
  loadWalkthroughSources,
  type Walkthrough,
  type WalkthroughEntry,
  WalkthroughView,
} from "./walkthrough.js";
import type { WalkthroughDrafts } from "./walkthrough-comments.js";
import type { Drafts } from "./drafts.js";

const PICK_KEYS = "abcdefghijklmnorstuvwxyz";

export interface PrTabHost {
  repo: string;
  repoSlug: string;
  pr: number;
  prHead: string;
  prWorktree: string;
  chosen: Map<string, string>;
  onQuit: () => void;
  openPath: (cwd: string, path: string, line: number, base?: string) => void;
  showPopup: (content: PopupContent, dismissable: boolean, keys?: Record<string, () => void>) => void;
  walkthroughDrafts?: WalkthroughDrafts;
  drafts?: Drafts;
}

export type FindingsTabHost = PrTabHost;

export function runPickerText(runs: RunEntry[]): string {
  return runs
    .slice(0, PICK_KEYS.length)
    .map((r, i) => `${PICK_KEYS[i]}  ${r.runId}  head ${r.head.slice(0, 10)}  ${r.verified ? "verified" : r.state}`)
    .join("\n");
}

export function walkthroughPickerText(entries: WalkthroughEntry[]): string {
  return entries
    .slice(0, PICK_KEYS.length)
    .map((w, i) => `${PICK_KEYS[i]}  ${w.id}  head ${w.head.slice(0, 10)}  ${w.title}`)
    .join("\n");
}

interface Producer<E extends { address: string }> {
  name: string;
  folder: string;
  list(): E[];
  pickerText(entries: E[]): string;
  view(address: string, open: (head: string, file: string, line: number, base?: string) => void): TabScreen;
}

/**
 * A PR tab over one producer folder in review-pr-N: loads the single entry,
 * asks once with a lettered picker when there are several, and remembers
 * the choice per PR in the host's `chosen` map.
 */
class ProducerTab<E extends { address: string }> implements TabScreen {
  private inner: TabScreen;
  private loaded = false;

  constructor(
    private readonly host: PrTabHost,
    private readonly producer: Producer<E>,
  ) {
    this.inner = this.notice([]);
    const entries = producer.list();
    const remembered = host.chosen.get(this.key);
    if (remembered !== undefined && entries.some((e) => e.address === remembered)) this.load(remembered);
    else if (entries.length === 1) this.load(entries[0]!.address);
    else this.pick(entries);
  }

  private get key(): string {
    return `${this.producer.folder}#${this.host.pr}`;
  }

  private notice(body: string[]): TabScreen {
    return new NoticeView({
      title: `${this.producer.name}  #${this.host.pr}`,
      subtitle: prContext(this.host.repoSlug, this.host.pr),
      body,
      onQuit: this.host.onQuit,
    });
  }

  private pick(entries = this.producer.list()): void {
    const where = `${prContext(this.host.repoSlug, this.host.pr)}/review/${this.producer.folder}/`;
    if (entries.length === 0) {
      this.inner = this.notice([`nothing in ${where}`]);
      return;
    }
    if (!this.loaded) this.inner = this.notice([`no ${this.producer.name} chosen`, "", "P pick one"]);
    const keys = Object.fromEntries(
      entries.slice(0, PICK_KEYS.length).map((e, i) => [PICK_KEYS[i]!, () => this.load(e.address)]),
    );
    this.host.showPopup({ title: this.producer.name, text: this.producer.pickerText(entries), footer: "any other key cancel" }, true, keys);
  }

  private load(address: string): void {
    try {
      this.inner = this.producer.view(address, (head, file, line, base) => void this.open(head, file, line, base));
      this.loaded = true;
      this.host.chosen.set(this.key, address);
    } catch (e) {
      this.inner = this.notice([e instanceof Error ? e.message : String(e), "", "P pick one"]);
    }
  }

  private async open(head: string, file: string, line: number, base?: string): Promise<void> {
    try {
      const cwd = head === this.host.prHead ? this.host.prWorktree : await findingsWorktree(this.host.repo, this.host.pr, head);
      this.host.openPath(cwd, file, line, base);
    } catch (e) {
      this.host.showPopup({ title: "open", text: e instanceof Error ? e.message : String(e), error: true, footer: "any key" }, true);
    }
  }

  invalidate(): void {
    this.inner.invalidate?.();
  }

  handleInput(data: string): void {
    if (data === "P") this.pick();
    else this.inner.handleInput(data);
  }

  handleEscape(): boolean {
    return this.inner.handleEscape?.() === true;
  }

  render(width: number): string[] {
    return this.inner.render(width);
  }
}

function requireHead(repo: string, head: string): void {
  if (!headInRepo(repo, head)) throw new Error(`head ${head.slice(0, 10)} is not in this repository (git fetch may help)`);
}

export function findingsTab(host: PrTabHost): TabScreen {
  return new ProducerTab<RunEntry>(host, {
    name: "review run",
    folder: "runs",
    list: () => listRuns(host.repoSlug, host.pr),
    pickerText: runPickerText,
    view: (address, open) => {
      const run = loadRun(address);
      requireHead(host.repo, run.head);
      const files = run.findings.flatMap((f) => (f.file === null ? [] : [f.file]));
      return new FindingsView({
        run,
        sources: loadSources(host.repo, run.head, files),
        onQuit: host.onQuit,
        onOpen: (file, line) => open(run.head, file, line, run.base),
      });
    },
  });
}

/** The walkthrough chosen for the PR, else the newest one, for drafts read before the tab loads it. */
export function currentWalkthrough(repoSlug: string, pr: number, chosen: Map<string, string>): Walkthrough | null {
  const address = chosen.get(`walkthrough#${pr}`) ?? listWalkthroughs(repoSlug, pr)[0]?.address;
  if (address === undefined) return null;
  try {
    return loadWalkthrough(address);
  } catch {
    return null;
  }
}

export function walkthroughTab(host: PrTabHost): TabScreen {
  return new ProducerTab<WalkthroughEntry>(host, {
    name: "walkthrough",
    folder: "walkthrough",
    list: () => listWalkthroughs(host.repoSlug, host.pr),
    pickerText: walkthroughPickerText,
    view: (address, open) => {
      const walkthrough = loadWalkthrough(address);
      requireHead(host.repo, walkthrough.head);
      host.walkthroughDrafts?.use(walkthrough);
      return new WalkthroughView({
        walkthrough,
        sources: loadWalkthroughSources(host.repo, walkthrough),
        subtitle: prContext(host.repoSlug, host.pr),
        onQuit: host.onQuit,
        onOpen: (rev, file, line) => open(rev, file, line, walkthrough.base),
        drafts: host.walkthroughDrafts,
        comments: host.drafts,
      });
    },
  });
}
