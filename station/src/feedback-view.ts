import { type Component, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
  FeedbackConversationEntry,
  FeedbackEvent,
  FeedbackResult,
  FeedbackThread,
  PrFeedback,
  RefreshOperation,
} from "../../github-service/src/protocol.js";
import { BOLD, C, fit, RESET, tailPath } from "./changes.js";
import { commentHunk, localGit, parseHunk, requiredCommits, resolveThread, type Located } from "./feedback-location.js";
import { runAsync } from "./git.js";
import { markdownRows } from "./markdown.js";
import { findingsWorktree, prContext } from "./pr-review.js";
import type { PrTabHost } from "./pr-tabs.js";
import { NoticeView, type TabScreen } from "./tabs.js";

const PROSE_WIDTH = 80;
const HUNK_TAIL = 12;

export type FeedbackItem = { kind: "thread"; thread: FeedbackThread } | { kind: "entry"; entry: FeedbackConversationEntry };

export type FeedbackSort = "github" | "newest" | "unresolved" | "file";

export const FEEDBACK_SORTS: readonly { sort: FeedbackSort; key: string; label: string; short: string }[] = [
  { sort: "github", key: "d", label: "GitHub order (comments oldest first)", short: "GitHub order" },
  { sort: "newest", key: "n", label: "newest activity first", short: "newest" },
  { sort: "unresolved", key: "u", label: "unresolved threads first, then newest", short: "unresolved first" },
  { sort: "file", key: "f", label: "file and line (comments oldest first)", short: "file" },
];

export const DEFAULT_FEEDBACK_SORT: FeedbackSort = "unresolved";

export function feedbackSortPickerText(current: FeedbackSort): string {
  return FEEDBACK_SORTS.map((s) => `${s.sort === current ? `${C.accent}●` : " "} ${C.text}${s.key}${C.dim}  ${s.label}`).join("\n");
}

function time(iso: string | null | undefined): number {
  const t = iso == null ? NaN : Date.parse(iso);
  return Number.isNaN(t) ? -Infinity : t;
}

function threadActivity(t: FeedbackThread): number {
  return t.comments.reduce((m, c) => Math.max(m, time(c.createdAt)), -Infinity);
}

function newestFirst(a: number, b: number): number {
  return a === b ? 0 : a > b ? -1 : 1;
}

function threadStart(t: FeedbackThread): number {
  if (t.subjectType === "FILE") return 0;
  return (t.line !== null ? (t.startLine ?? t.line) : (t.originalStartLine ?? t.originalLine)) ?? 0;
}

function sortThreads(threads: readonly FeedbackThread[], sort: FeedbackSort): FeedbackThread[] {
  const out = [...threads];
  if (sort === "newest") out.sort((a, b) => newestFirst(threadActivity(a), threadActivity(b)));
  else if (sort === "unresolved") {
    out.sort((a, b) => Number(a.isResolved) - Number(b.isResolved) || newestFirst(threadActivity(a), threadActivity(b)));
  } else if (sort === "file") {
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || threadStart(a) - threadStart(b));
  }
  return out;
}

function sortConversation(entries: readonly FeedbackConversationEntry[], sort: FeedbackSort): FeedbackConversationEntry[] {
  const out = [...entries];
  if (sort === "newest" || sort === "unresolved") out.sort((a, b) => newestFirst(time(a.createdAt), time(b.createdAt)));
  return out;
}

export function feedbackItems(s: PrFeedback, sort: FeedbackSort = DEFAULT_FEEDBACK_SORT): FeedbackItem[] {
  return [
    ...sortThreads(s.threads, sort).map((thread) => ({ kind: "thread" as const, thread })),
    ...sortConversation(s.conversation, sort).map((entry) => ({ kind: "entry" as const, entry })),
  ];
}

export function itemUrl(item: FeedbackItem): string | null {
  return item.kind === "thread" ? (item.thread.comments[0]?.url ?? null) : item.entry.url;
}

function itemId(item: FeedbackItem): string {
  return item.kind === "thread" ? item.thread.id : item.entry.id;
}

export function when(iso: string | null): string {
  if (iso === null || iso === "") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function stamp(ms: number | null): string {
  return ms === null ? "never" : when(new Date(ms).toISOString());
}

function login(a: { login: string | null }): string {
  return a.login ?? "ghost";
}

function threadLine(t: FeedbackThread): number | null {
  return t.line ?? t.originalLine;
}

export function threadLocation(t: FeedbackThread): string {
  if (t.subjectType === "FILE") return `${t.path} (file)`;
  const end = threadLine(t);
  if (end === null) return t.path;
  const start = t.line !== null ? t.startLine : t.originalStartLine;
  return start !== null && start !== end ? `${t.path}:${start}-${end}` : `${t.path}:${end}`;
}

function threadTags(t: FeedbackThread): string[] {
  const tags: string[] = [];
  if (t.isResolved) tags.push("resolved");
  if (t.isOutdated) tags.push("outdated");
  return tags;
}

export function entryLabel(e: FeedbackConversationEntry): string {
  if (e.kind !== "review") return "PR comment";
  const state = e.state?.toLowerCase().replace(/_/g, " ") ?? "";
  return state === "" || state === "commented" ? "review" : `review ${state}`;
}

function countText(n: number): string {
  return `${n} comment${n === 1 ? "" : "s"}`;
}

export interface FeedbackViewOptions {
  feedback: PrFeedback;
  fetchedAt: number | null;
  onQuit: () => void;
  onOpen: (thread: FeedbackThread) => void;
  onGeneral: () => void;
  onCopy: (text: string) => void;
  onPickSort: (current: FeedbackSort, choose: (sort: FeedbackSort) => void) => void;
  prHead?: string;
}

export class FeedbackView implements Component {
  private cursor = 0;
  private offset = 0;
  private listOffset = 0;
  private lastHeight = 20;
  private items: FeedbackItem[];
  private sort: FeedbackSort = DEFAULT_FEEDBACK_SORT;
  private sidebar = true;
  private notice: { text: string; error: boolean } | null = null;
  note = "";

  constructor(private readonly opts: FeedbackViewOptions) {
    this.items = feedbackItems(opts.feedback);
  }

  sortBy(): FeedbackSort {
    return this.sort;
  }

  setSort(sort: FeedbackSort): void {
    const keep = this.current();
    this.sort = sort;
    this.items = feedbackItems(this.opts.feedback, sort);
    const index = keep === undefined ? -1 : this.items.findIndex((i) => itemId(i) === itemId(keep));
    this.cursor = Math.max(0, index);
    if (index < 0) this.offset = 0;
  }

  invalidate(): void {}

  get feedback(): PrFeedback {
    return this.opts.feedback;
  }

  current(): FeedbackItem | undefined {
    return this.items[this.cursor];
  }

  restorePosition(previous: FeedbackView): void {
    this.sidebar = previous.sidebar;
    if (previous.sort !== this.sort) {
      this.sort = previous.sort;
      this.items = feedbackItems(this.opts.feedback, this.sort);
    }
    const prev = previous.current();
    const index = prev === undefined ? -1 : this.items.findIndex((i) => itemId(i) === itemId(prev));
    this.cursor = index >= 0 ? index : Math.max(0, Math.min(previous.cursor, this.items.length - 1));
    if (index >= 0) this.offset = previous.offset;
    this.listOffset = previous.listOffset;
  }

  private move(delta: number): void {
    const n = this.items.length;
    if (n === 0) return;
    this.cursor = (this.cursor + delta + n) % n;
    this.offset = 0;
  }

  private copyLink(): void {
    const item = this.current();
    const url = item === undefined ? null : itemUrl(item);
    if (url === null || url === "") {
      this.notice = { text: `copy failed: ${item === undefined ? "nothing selected" : "no GitHub link for this item"}`, error: true };
      return;
    }
    try {
      this.opts.onCopy(url);
      this.notice = { text: "link copied", error: false };
    } catch (e) {
      this.notice = { text: `copy failed: ${e instanceof Error ? e.message : String(e)}`, error: true };
    }
  }

  handleInput(data: string): void {
    this.notice = null;
    const h = this.lastHeight;
    if (matchesKey(data, "ctrl+down") || matchesKey(data, "down")) this.move(1);
    else if (matchesKey(data, "ctrl+up") || matchesKey(data, "up")) this.move(-1);
    else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) this.offset += Math.floor(h / 2);
    else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) this.offset -= Math.floor(h / 2);
    else if (matchesKey(data, "shift+down")) this.offset += 3;
    else if (matchesKey(data, "shift+up")) this.offset -= 3;
    else {
      switch (data) {
        case "q":
        case "\x03":
          this.opts.onQuit();
          return;
        case "j":
          this.move(1);
          return;
        case "k":
          this.move(-1);
          return;
        case "y":
          this.copyLink();
          return;
        case "s":
          this.opts.onPickSort(this.sort, (sort) => this.setSort(sort));
          return;
        case "t":
          this.sidebar = !this.sidebar;
          return;
        case "g":
          this.cursor = 0;
          this.offset = 0;
          return;
        case "G":
          this.cursor = Math.max(0, this.items.length - 1);
          this.offset = 0;
          return;
        case "J":
          this.offset += 3;
          return;
        case "K":
          this.offset -= 3;
          return;
        case " ":
          this.offset += Math.floor(h / 2);
          return;
        case "e": {
          const item = this.current();
          if (item?.kind === "thread") this.opts.onOpen(item.thread);
          else if (item !== undefined) this.opts.onGeneral();
          return;
        }
        default:
          return;
      }
    }
  }

  private section(title: string): string[] {
    return ["", `${C.accent}${BOLD}${title}${RESET}`, ""];
  }

  private body(text: string, w: number): string[] {
    const rows = markdownRows(text, Math.min(w, PROSE_WIDTH));
    return rows.length === 0 ? [`${C.faint}(no text)`] : rows;
  }

  private hunkRows(t: FeedbackThread, w: number): string[] {
    const hunk = commentHunk(t, t.comments[0]);
    const out = this.section("Captured diff");
    if (hunk === null || hunk === "") return [...out, `${C.faint}no diff captured for this thread`];
    const lines = parseHunk(hunk);
    if (lines === null) return [...out, ...hunk.split("\n").map((l) => `${C.dim}${l}`)];
    const left = t.diffSide === "LEFT";
    const end = t.originalLine;
    const start = t.originalStartLine ?? end;
    const shown = lines.slice(-HUNK_TAIL);
    if (lines.length > shown.length) out.push(`${C.faint}  … ${lines.length - shown.length} earlier lines`);
    for (const l of shown) {
      const n = left ? l.old : l.new;
      const on = n !== null && start !== null && end !== null && n >= Math.min(start, end) && n <= Math.max(start, end);
      const color = l.kind === "+" ? C.add : l.kind === "-" ? C.del : C.text;
      const bg = on ? C.selBg : l.kind === "+" ? C.addBg : l.kind === "-" ? C.delBg : "";
      const num = (v: number | null): string => (v === null ? "     " : String(v).padStart(5));
      const gutter = `${on ? C.accent : C.faint}${num(l.old)} ${num(l.new)} ${on ? "▎" : " "}`;
      out.push(gutter + RESET + bg + fit(`${color}${l.kind}${l.text.replace(/\t/g, "    ")}`, w - 14) + RESET);
    }
    return out;
  }

  private threadRows(t: FeedbackThread, w: number): string[] {
    const out = wrapTextWithAnsi(`${C.text}${BOLD}${threadLocation(t)}`, Math.min(w, PROSE_WIDTH));
    out.push("");
    const tag = (label: string, value: string, color = C.text): string => `${C.dim}${label} ${color}${value}${RESET}   `;
    out.push(
      tag("state", t.isResolved ? `resolved${t.resolvedBy === null ? "" : ` by ${t.resolvedBy}`}` : "unresolved", t.isResolved ? C.dim : C.mod) +
        (t.isOutdated ? tag("", "outdated", C.mod) : "") +
        (t.subjectType === "FILE" ? tag("", "file comment") : ""),
    );
    const origin = t.comments[0]?.originalCommit ?? null;
    const lines = [
      t.line === null ? null : `line ${t.line} at PR head`,
      t.originalLine === null ? null : `line ${t.originalLine} at ${origin === null ? "original commit" : origin.slice(0, 10)}`,
    ].filter((x) => x !== null);
    if (lines.length > 0) out.push(`${C.dim}${lines.join("   ")}`);
    if (t.commentsTotal > t.comments.length) out.push(`${C.mod}showing ${t.comments.length} of ${t.commentsTotal} comments`);
    out.push(...this.hunkRows(t, w));
    out.push(...this.section(`Conversation (${t.comments.length})`));
    t.comments.forEach((c, i) => {
      if (i > 0) out.push(`${C.faint}${"─".repeat(Math.min(w, PROSE_WIDTH))}`);
      const extra = [
        c.lastEditedAt !== null ? "edited" : null,
        c.state === "PENDING" ? "pending" : null,
        c.isMinimized ? `hidden${c.minimizedReason === null ? "" : `: ${c.minimizedReason.toLowerCase()}`}` : null,
      ].filter((x) => x !== null);
      out.push(`${C.accent}${login(c.author)}${C.dim}  ${when(c.createdAt)}${extra.length > 0 ? `  ${extra.join("  ")}` : ""}`);
      out.push(...this.body(c.body, w));
      out.push("");
    });
    return out;
  }

  private entryRows(e: FeedbackConversationEntry, w: number): string[] {
    const head = e.kind === "review" ? `review ${e.state?.toLowerCase().replace("_", " ") ?? ""}` : "comment";
    const out = wrapTextWithAnsi(`${C.text}${BOLD}${head}`, Math.min(w, PROSE_WIDTH));
    out.push("");
    const extra = [
      e.lastEditedAt !== null ? "edited" : null,
      e.commit === null ? null : `at ${e.commit.slice(0, 10)}`,
      e.isMinimized ? `hidden${e.minimizedReason === null ? "" : `: ${e.minimizedReason.toLowerCase()}`}` : null,
    ].filter((x) => x !== null);
    out.push(`${C.accent}${login(e.author)}${C.dim}  ${when(e.createdAt)}${extra.length > 0 ? `  ${extra.join("  ")}` : ""}`);
    out.push("");
    out.push(...this.body(e.body, w));
    out.push("");
    return out;
  }

  private renderList(height: number, w: number): string[] {
    const s = this.opts.feedback;
    type Row = { text: string; item: number | null };
    const rows: Row[] = [];
    const header = (label: string, count: number): void => {
      rows.push({ text: C.barBg + fit(` ${C.text}${BOLD}${label}${RESET}${C.barBg} ${C.dim}${count}`, w) + RESET, item: null });
    };
    const entry = (i: number, label: string, tags: string[], author: string | null, count: number, dim: boolean): void => {
      const on = i === this.cursor;
      const base = on ? C.selBg : "";
      const marker = on ? `${C.accent}▎` : " ";
      const tagText = tags.length === 0 ? "" : `${C.mod}${tags.join(" ")}  `;
      const sub = `${tagText}${C.dim}${author === null ? "" : `${author} · `}${countText(count)}`;
      rows.push({ text: base + fit(`${marker}${dim ? C.faint : on ? `${C.text}${BOLD}` : C.text}${label}`, w) + RESET, item: i });
      rows.push({ text: base + fit(`${marker}${sub}`, w) + RESET, item: i });
    };
    header("Code threads", s.threads.length);
    if (s.threads.length === 0) rows.push({ text: ` ${C.faint}no review threads`, item: null });
    this.items.forEach((item, i) => {
      if (item.kind !== "thread") return;
      const t = item.thread;
      const first = t.comments[0];
      entry(i, tailPath(threadLocation(t), w - 1), threadTags(t), first === undefined ? null : login(first.author), t.commentsTotal, t.isResolved);
    });
    header("Conversation", s.conversation.length);
    if (s.conversation.length === 0) rows.push({ text: ` ${C.faint}no general comments`, item: null });
    this.items.forEach((item, i) => {
      if (item.kind !== "entry") return;
      const e = item.entry;
      entry(i, entryLabel(e), e.isMinimized ? ["hidden"] : [], login(e.author), 1, e.isMinimized);
    });
    const first = rows.findIndex((r) => r.item === this.cursor);
    if (first >= 0) {
      let last = first;
      while (rows[last + 1]?.item === this.cursor) last++;
      if (last + 1 > this.listOffset + height) this.listOffset = last + 1 - height;
      const top = rows[first - 1]?.item === null ? first - 1 : first;
      if (top < this.listOffset) this.listOffset = top;
    }
    this.listOffset = Math.max(0, Math.min(this.listOffset, Math.max(0, rows.length - height)));
    const out = rows.slice(this.listOffset, this.listOffset + height).map((r) => r.text);
    while (out.length < height) out.push(" ".repeat(w));
    return out;
  }

  render(width: number): string[] {
    const total = Math.max(8, process.stdout.rows ?? 40);
    const bodyH = total - 3;
    this.lastHeight = bodyH;
    const s = this.opts.feedback;
    const out: string[] = [];
    out.push(C.titleBg + fit(` ${C.text}${BOLD}github  #${s.pr.number}  ${s.pr.title}`, width) + RESET);
    const unresolved = s.threads.filter((t) => !t.isResolved).length;
    const moved = this.opts.prHead !== undefined && this.opts.prHead !== s.pr.headSha
      ? `   ${C.mod}PR head in station is ${this.opts.prHead.slice(0, 10)}` : "";
    const note = this.note === "" ? "" : `   ${C.mod}${this.note}`;
    out.push(
      C.barBg +
        fit(
          ` ${C.dim}fetched ${C.text}${stamp(this.opts.fetchedAt)}${C.dim}   head ${C.text}${s.pr.headSha.slice(0, 10)}${C.dim}   ` +
            `${s.threads.length} threads (${unresolved} unresolved)   ${s.conversation.length} conversation${moved}${note}`,
          width,
        ) +
        RESET,
    );
    const sideW = this.sidebar ? Math.min(56, Math.max(28, Math.floor(width * 0.34))) : 0;
    const mainW = this.sidebar ? width - sideW - 1 : width;
    const pad = 2;
    const item = this.current();
    const rows =
      item === undefined
        ? ["", `${C.faint}no review threads or general comments on this pull request`]
        : item.kind === "thread"
          ? this.threadRows(item.thread, mainW - pad)
          : this.entryRows(item.entry, mainW - pad);
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - bodyH)));
    const side = this.sidebar ? this.renderList(bodyH, sideW) : [];
    for (let i = 0; i < bodyH; i++) {
      const row = rows[this.offset + i] ?? "";
      const main = fit(" ".repeat(pad) + truncateToWidth(row, mainW - pad, ""), mainW);
      out.push(this.sidebar ? `${main}${RESET}${C.faint}│${RESET}${side[i] ?? ""}` : `${main}${RESET}`);
    }
    const k = (key: string, what: string): string => `${C.text}${key}${C.dim} ${what}  `;
    const more = this.offset + bodyH < rows.length ? `${C.accent}more ↓  ` : "";
    const sort = FEEDBACK_SORTS.find((x) => x.sort === this.sort)?.short ?? this.sort;
    const pos = this.items.length === 0 ? "" : `sort: ${sort}  item ${this.cursor + 1}/${this.items.length} `;
    const right = `${more}${C.dim}${pos}`;
    const left = this.notice === null
      ? ` ${k("R", "refresh")}${k("↑/↓ ^↑/^↓", "item")}${k("⇧↑/⇧↓ pgup/pgdn", "scroll")}${k("e", "open")}${k("y", "copy link")}` +
        `${k("s", "sort")}${k("t", this.sidebar ? "hide list" : "show list")}${k("q", "quit")}`
      : truncateToWidth(` ${this.notice.error ? C.del : C.add}${this.notice.text}`, Math.max(1, width - visibleWidth(right) - 2), "…");
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    out.push(C.barBg + fit(`${left}${" ".repeat(gap)}${right}`, width) + RESET);
    return out;
  }
}

export interface FeedbackTabDeps {
  read: () => Promise<FeedbackResult>;
  refresh: (onProgress: (operation: RefreshOperation) => void) => Promise<RefreshOperation>;
  watch: (listener: (event: FeedbackEvent) => void) => () => void;
  fetchCommits: (shas: string[]) => Promise<void>;
}

export function serviceRepo(host: PrTabHost): string {
  return host.repoSlug.toLowerCase();
}

export function defaultFeedbackDeps(host: PrTabHost): FeedbackTabDeps {
  const repo = serviceRepo(host);
  return {
    read: () => host.github.feedback(repo, host.pr),
    refresh: (onProgress) => host.github.refreshFeedback(repo, host.pr, onProgress),
    watch: (listener) => host.github.onFeedback(listener),
    fetchCommits: async (shas) => {
      await runAsync(host.repo, ["fetch", "-q", "--no-tags", "origin", ...shas]);
    },
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Phase = { kind: "loading" } | { kind: "refreshing"; pausedUntil: number | null } | { kind: "idle" };

/**
 * The github tab of a PR: shows the PR feedback snapshot of the GitHub
 * service and asks the service to refetch it from GitHub only on R. Feedback
 * events for the PR mark the shown data as stale without replacing it.
 * Opening a thread resolves its revision and side-specific line first and
 * refuses locations it cannot verify.
 */
export class FeedbackTab implements TabScreen {
  private view: FeedbackView | null = null;
  private result: FeedbackResult | null = null;
  private phase: Phase = { kind: "loading" };
  private error: string | null = null;
  private latest: { storeId: string; revision: number } | null = null;
  private progress = "";
  private opening = false;
  private closed = false;
  private readonly repo: string;
  private readonly unwatch: () => void;

  constructor(
    private readonly host: PrTabHost,
    private readonly deps: FeedbackTabDeps = defaultFeedbackDeps(host),
  ) {
    this.repo = serviceRepo(host);
    this.unwatch = deps.watch((event) => this.onEvent(event));
    void this.load().then((failure) => this.finish(failure));
  }

  private onEvent(event: FeedbackEvent): void {
    if (this.closed || event.repo !== this.repo || event.number !== this.host.pr) return;
    const latest = this.latest;
    if (latest === null || latest.storeId !== event.storeId || event.revision > latest.revision) {
      this.latest = { storeId: event.storeId, revision: event.revision };
    }
    this.changed();
  }

  get stale(): boolean {
    const latest = this.latest;
    if (latest === null) return false;
    const shown = this.result;
    return shown === null || shown.storeId !== latest.storeId || latest.revision > shown.revision;
  }

  private paused(pausedUntil: number | null | undefined): string | null {
    return pausedUntil != null && pausedUntil > Date.now() ? `GitHub rate limited until ${stamp(pausedUntil)}` : null;
  }

  private status(): { text: string; error: boolean }[] {
    const out: { text: string; error: boolean }[] = [];
    if (this.phase.kind === "refreshing") {
      const paused = this.paused(this.phase.pausedUntil);
      out.push({ text: paused === null ? "refreshing through GitHub service…" : `refresh waiting: ${paused}`, error: false });
    }
    if (this.error !== null) out.push({ text: this.error, error: true });
    if (this.result?.error != null) out.push({ text: `last GitHub fetch failed: ${this.result.error}`, error: true });
    if (this.phase.kind !== "refreshing") {
      const paused = this.paused(this.result?.pausedUntil);
      if (paused !== null) out.push({ text: paused, error: true });
    }
    if (this.stale) out.push({ text: "new feedback available · R refresh", error: false });
    if (this.progress !== "") out.push({ text: this.progress, error: false });
    return out;
  }

  private changed(): void {
    if (this.view !== null) {
      this.view.note = this.status()
        .map((s) => `${s.error ? C.del : C.mod}${s.text}`)
        .join(`${C.dim} · `);
    }
    this.host.requestRender?.();
  }

  private use(result: FeedbackResult): void {
    if (result.repo !== this.repo || result.number !== this.host.pr) {
      throw new Error(`feedback is for ${result.repo}#${result.number}, not ${this.repo}#${this.host.pr}`);
    }
    this.result = result;
    const feedback = result.feedback;
    if (feedback === null) {
      this.view = null;
      return;
    }
    const next = new FeedbackView({
      feedback,
      fetchedAt: result.fetchedAt,
      onQuit: this.host.onQuit,
      onOpen: (t) => void this.open(t, feedback),
      onGeneral: () =>
        this.host.showPopup({ title: "open", text: "general PR comments have no code location to open", footer: "any key" }, true),
      onCopy: (text) => {
        if (this.host.onCopy === undefined) throw new Error("no clipboard available");
        this.host.onCopy(text);
      },
      onPickSort: (current, choose) =>
        this.host.showPopup(
          { title: "sort", text: feedbackSortPickerText(current), footer: "any other key cancel" },
          true,
          Object.fromEntries(FEEDBACK_SORTS.map((s) => [s.key, () => {
            choose(s.sort);
            this.host.requestRender?.();
          }])),
        ),
      prHead: this.host.prHead,
    });
    if (this.view !== null) next.restorePosition(this.view);
    this.view = next;
  }

  private async load(): Promise<string | null> {
    try {
      const result = await this.deps.read();
      if (!this.closed) this.use(result);
      return null;
    } catch (e) {
      return `GitHub service: ${errText(e)}`;
    }
  }

  private finish(failure: string | null): void {
    if (this.closed) return;
    this.phase = { kind: "idle" };
    this.error = failure;
    if (failure !== null && this.view !== null) {
      this.host.showPopup({ title: "github", text: failure, error: true, footer: "any key" }, true);
    }
    this.changed();
  }

  private notice(): TabScreen {
    const n = this.host.pr;
    const status = this.status().map((s) => s.text);
    const hint = "R refresh through the GitHub service (read-only)";
    const body =
      this.phase.kind === "loading"
        ? ["loading feedback from the GitHub service…"]
        : this.phase.kind === "refreshing"
          ? status
          : this.result === null
            ? [...status, "", hint]
            : [`no GitHub feedback collected for #${n} yet`, ...status, "", hint];
    return new NoticeView({ title: `github  #${n}`, subtitle: prContext(this.host.repoSlug, n), body, onQuit: this.host.onQuit, hints: "R refresh" });
  }

  async refresh(): Promise<void> {
    if (this.phase.kind !== "idle" || this.closed) return;
    const phase = { kind: "refreshing" as const, pausedUntil: null as number | null };
    this.phase = phase;
    this.error = null;
    this.changed();
    let failure: string | null = null;
    try {
      const operation = await this.deps.refresh((op) => {
        phase.pausedUntil = op.pausedUntil ?? null;
        this.changed();
      });
      const outcome = operation.feedback;
      if (outcome?.state === "error") failure = `refresh failed: ${outcome.error ?? "unknown error"}`;
    } catch (e) {
      failure = `GitHub service: ${errText(e)}`;
    }
    const reload = await this.load();
    this.finish(failure ?? reload);
  }

  async open(thread: FeedbackThread, feedback: PrFeedback): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    const fail = (text: string): void =>
      this.host.showPopup({ title: "open", text: `${text}\n\nThe captured diff stays in the detail view.`, error: true, footer: "any key" }, true);
    try {
      const git = localGit(this.host.repo);
      const missing = [...new Set(requiredCommits(thread, feedback))].filter((s) => !git.hasCommit(s));
      if (missing.length > 0) {
        this.progress = `fetching ${missing.map((s) => s.slice(0, 10)).join(" ")} from origin…`;
        this.changed();
        await this.deps.fetchCommits(missing).catch(() => undefined);
        this.progress = "";
        this.changed();
      }
      const loc = resolveThread(thread, feedback, git);
      if (!loc.ok) {
        fail(`cannot open ${threadLocation(thread)}: ${loc.reason}`);
        return;
      }
      await this.openAt(loc);
    } catch (e) {
      fail(errText(e));
    } finally {
      this.opening = false;
      this.host.requestRender?.();
    }
  }

  private async worktreeFor(rev: string): Promise<string> {
    if (rev === this.host.prHead) {
      const head = (await runAsync(this.host.prWorktree, ["rev-parse", "HEAD"]).catch(() => "")).trim();
      if (head === rev) return this.host.prWorktree;
    }
    return findingsWorktree(this.host.repo, this.host.pr, rev);
  }

  private async openAt(loc: Extract<Located, { ok: true }>): Promise<void> {
    const cwd = await this.worktreeFor(loc.rev);
    const go = (): void => this.host.openPath(cwd, loc.path, loc.line, loc.base ?? undefined);
    const dirty = (await runAsync(cwd, ["status", "--porcelain", "--", loc.path])).trim() !== "";
    if (dirty) {
      this.host.showPopup(
        {
          title: "open",
          text: `${loc.path} has uncommitted changes in ${cwd}; line ${loc.line} refers to ${loc.rev.slice(0, 10)} and may have moved.`,
          footer: "y open anyway · any other key cancel",
        },
        true,
        { y: go },
      );
      return;
    }
    go();
  }

  invalidate(): void {
    this.view?.invalidate();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unwatch();
  }

  handleInput(data: string): void {
    if (data === "R") void this.refresh();
    else if (this.view !== null) this.view.handleInput(data);
    else if (data === "q") this.host.onQuit();
  }

  render(width: number): string[] {
    return (this.view ?? this.notice()).render(width);
  }
}

export function githubTab(host: PrTabHost): TabScreen {
  return new FeedbackTab(host);
}
