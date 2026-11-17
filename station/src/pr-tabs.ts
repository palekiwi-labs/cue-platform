import type { ComposeRequest } from "./changes.js";
import type { PopupContent } from "./popup.js";
import { ReaderView } from "./reader.js";
import { findingDoc, type ReaderComments, type ReaderDoc, walkthroughDoc, walkthroughItem } from "./reader-comments.js";
import { FindingsView, headInRepo, loadRun, loadSources } from "./findings.js";
import { findingsWorktree, listRuns, prContext, type RunEntry } from "./pr-review.js";
import { NoticeView, type TabScreen } from "./tabs.js";
import { listWalkthroughs, loadWalkthrough, loadWalkthroughSources, type WalkthroughEntry, WalkthroughView } from "./walkthrough.js";

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
  readerComments: ReaderComments;
  compose: (request: ComposeRequest, done: (text: string | null) => void) => void;
  copy: (text: string) => void;
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
  view(
    address: string,
    open: (head: string, file: string, line: number, base?: string) => void,
    read: (doc: ReaderDoc) => void,
  ): TabScreen;
}

/**
 * A PR tab over one producer folder in review-pr-N: loads the single entry,
 * asks once with a lettered picker when there are several, and remembers
 * the choice per PR in the host's `chosen` map.
 */
class ProducerTab<E extends { address: string }> implements TabScreen {
  private inner: TabScreen;
  private reader: ReaderView | null = null;
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
      this.inner = this.producer.view(
        address,
        (head, file, line, base) => void this.open(head, file, line, base),
        (doc) => this.read(doc),
      );
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

  private read(doc: ReaderDoc): void {
    this.reader = new ReaderView({
      doc,
      comments: this.host.readerComments,
      onClose: () => {
        this.reader = null;
      },
      onCompose: this.host.compose,
      onCopy: this.host.copy,
    });
  }

  invalidate(): void {
    this.inner.invalidate?.();
  }

  handleInput(data: string): void {
    if (this.reader !== null) this.reader.handleInput(data);
    else if (data === "P") this.pick();
    else this.inner.handleInput(data);
  }

  handleEscape(): boolean {
    if (this.reader !== null) return this.reader.handleEscape();
    return this.inner.handleEscape?.() === true;
  }

  render(width: number): string[] {
    return (this.reader ?? this.inner).render(width);
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
    view: (address, open, read) => {
      const run = loadRun(address);
      const store = host.readerComments;
      requireHead(host.repo, run.head);
      const files = run.findings.flatMap((f) => (f.file === null ? [] : [f.file]));
      return new FindingsView({
        run,
        sources: loadSources(host.repo, run.head, files),
        onQuit: host.onQuit,
        onOpen: (file, line) => open(run.head, file, line, run.base),
        onRead: (f) => read(findingDoc(run, f)),
        commentCount: (f) => store.forTarget({ kind: "finding", source: run.address, item: f.id, item_title: f.title }).length,
      });
    },
  });
}

export function walkthroughTab(host: PrTabHost): TabScreen {
  return new ProducerTab<WalkthroughEntry>(host, {
    name: "walkthrough",
    folder: "walkthrough",
    list: () => listWalkthroughs(host.repoSlug, host.pr),
    pickerText: walkthroughPickerText,
    view: (address, open, read) => {
      const walkthrough = loadWalkthrough(address);
      const store = host.readerComments;
      requireHead(host.repo, walkthrough.head);
      return new WalkthroughView({
        walkthrough,
        sources: loadWalkthroughSources(host.repo, walkthrough),
        subtitle: prContext(host.repoSlug, host.pr),
        onQuit: host.onQuit,
        onOpen: (rev, file, line) => open(rev, file, line, walkthrough.base),
        onRead: (chunk, section, step) => {
          const doc = walkthroughDoc(walkthrough, chunk, section, step);
          if (doc !== null) read(doc);
        },
        commentCount: (chunk, section, step) => {
          const id = walkthrough.chunks[chunk]?.id;
          if (id === undefined) return 0;
          const item = walkthroughItem(id, section, step);
          return store.all().filter((c) => c.kind === "walkthrough" && c.source === walkthrough.address && c.item === item).length;
        },
      });
    },
  });
}
