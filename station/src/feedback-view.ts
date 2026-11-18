import { type Component, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { BOLD, C, fit, RESET, tailPath } from "./changes.js";
import { localGit, parseHunk, requiredCommits, resolveThread, type Located } from "./feedback-location.js";
import { runAsync } from "./git.js";
import {
  type ConversationEntry,
  feedbackCachePath,
  type FeedbackSnapshot,
  fetchFeedback,
  ghGraphql,
  loadSnapshot,
  type ReviewThread,
  saveSnapshot,
} from "./github-feedback.js";
import { markdownRows } from "./markdown.js";
import { findingsWorktree, prContext } from "./pr-review.js";
import type { PrTabHost } from "./pr-tabs.js";
import { NoticeView, type TabScreen } from "./tabs.js";

const PROSE_WIDTH = 80;
const HUNK_TAIL = 12;

const EXCERPT_ROWS = 2;

export type FeedbackItem = { kind: "thread"; thread: ReviewThread } | { kind: "entry"; entry: ConversationEntry };

export type FeedbackSort = "github" | "newest" | "unresolved" | "file";

export const FEEDBACK_SORTS: readonly { sort: FeedbackSort; key: string; label: string; short: string }[] = [
  { sort: "github", key: "d", label: "GitHub order (comments oldest first)", short: "GitHub order" },
  { sort: "newest", key: "n", label: "newest activity first", short: "newest" },
  { sort: "unresolved", key: "u", label: "unresolved threads first, then newest", short: "unresolved first" },
  { sort: "file", key: "f", label: "file and line (comments oldest first)", short: "file" },
];

export function feedbackSortPickerText(current: FeedbackSort): string {
  return FEEDBACK_SORTS.map((s) => `${s.sort === current ? `${C.accent}●` : " "} ${C.text}${s.key}${C.dim}  ${s.label}`).join("\n");
}

function time(iso: string | null | undefined): number {
  const t = iso == null ? NaN : Date.parse(iso);
  return Number.isNaN(t) ? -Infinity : t;
}

function threadActivity(t: ReviewThread): number {
  return t.comments.reduce((m, c) => Math.max(m, time(c.created_at)), -Infinity);
}

function newestFirst(a: number, b: number): number {
  return a === b ? 0 : a > b ? -1 : 1;
}

function threadStart(t: ReviewThread): number {
  if (t.subject_type === "FILE") return 0;
  return (t.line !== null ? (t.start_line ?? t.line) : (t.original_start_line ?? t.original_line)) ?? 0;
}

function sortThreads(threads: readonly ReviewThread[], sort: FeedbackSort): ReviewThread[] {
  const out = [...threads];
  if (sort === "newest") out.sort((a, b) => newestFirst(threadActivity(a), threadActivity(b)));
  else if (sort === "unresolved") {
    out.sort((a, b) => Number(a.is_resolved) - Number(b.is_resolved) || newestFirst(threadActivity(a), threadActivity(b)));
  } else if (sort === "file") {
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || threadStart(a) - threadStart(b));
  }
  return out;
}

function sortConversation(entries: readonly ConversationEntry[], sort: FeedbackSort): ConversationEntry[] {
  const out = [...entries];
  if (sort === "newest" || sort === "unresolved") out.sort((a, b) => newestFirst(time(a.created_at), time(b.created_at)));
  return out;
}

export function feedbackItems(s: FeedbackSnapshot, sort: FeedbackSort = "github"): FeedbackItem[] {
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
  return `${d.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

function login(a: { login: string | null }): string {
  return a.login ?? "ghost";
}

function threadLine(t: ReviewThread): number | null {
  return t.line ?? t.original_line;
}

export function threadLocation(t: ReviewThread): string {
  if (t.subject_type === "FILE") return `${t.path} (file)`;
  const end = threadLine(t);
  if (end === null) return t.path;
  const start = t.line !== null ? t.start_line : t.original_start_line;
  return start !== null && start !== end ? `${t.path}:${start}-${end}` : `${t.path}:${end}`;
}

function threadTags(t: ReviewThread): string[] {
  const tags: string[] = [];
  if (t.is_resolved) tags.push("resolved");
  if (t.is_outdated) tags.push("outdated");
  return tags;
}

function excerpt(body: string, width: number): string[] {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat === "" || width <= 1) return [];
  const rows = wrapTextWithAnsi(flat, width);
  if (rows.length <= EXCERPT_ROWS) return rows;
  const shown = rows.slice(0, EXCERPT_ROWS);
  shown[EXCERPT_ROWS - 1] = `${truncateToWidth(shown[EXCERPT_ROWS - 1]!, width - 1, "")}…`;
  return shown;
}

export interface FeedbackViewOptions {
  snapshot: FeedbackSnapshot;
  onQuit: () => void;
  onOpen: (thread: ReviewThread) => void;
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
  private sort: FeedbackSort = "github";
  private sidebar = true;
  private notice: { text: string; error: boolean } | null = null;
  note = "";

  constructor(private readonly opts: FeedbackViewOptions) {
    this.items = feedbackItems(opts.snapshot);
  }

  sortBy(): FeedbackSort {
    return this.sort;
  }

  setSort(sort: FeedbackSort): void {
    const keep = this.current();
    this.sort = sort;
    this.items = feedbackItems(this.opts.snapshot, sort);
    const index = keep === undefined ? -1 : this.items.findIndex((i) => itemId(i) === itemId(keep));
    this.cursor = Math.max(0, index);
    if (index < 0) this.offset = 0;
  }

  invalidate(): void {}

  get snapshot(): FeedbackSnapshot {
    return this.opts.snapshot;
  }

  current(): FeedbackItem | undefined {
    return this.items[this.cursor];
  }

  restorePosition(previous: FeedbackView): void {
    this.sidebar = previous.sidebar;
    if (previous.sort !== this.sort) {
      this.sort = previous.sort;
      this.items = feedbackItems(this.opts.snapshot, this.sort);
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
      this.notice = { text: `copied ${url}`, error: false };
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

  private hunkRows(t: ReviewThread, w: number): string[] {
    const hunk = t.comments[0]?.diff_hunk ?? null;
    const out = this.section("Captured diff");
    if (hunk === null || hunk === "") return [...out, `${C.faint}no diff captured for this thread`];
    const lines = parseHunk(hunk);
    if (lines === null) return [...out, ...hunk.split("\n").map((l) => `${C.dim}${l}`)];
    const left = t.diff_side === "LEFT";
    const end = t.original_line;
    const start = t.original_start_line ?? end;
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

  private threadRows(t: ReviewThread, w: number): string[] {
    const out = wrapTextWithAnsi(`${C.text}${BOLD}${threadLocation(t)}`, Math.min(w, PROSE_WIDTH));
    out.push("");
    const tag = (label: string, value: string, color = C.text): string => `${C.dim}${label} ${color}${value}${RESET}   `;
    out.push(
      tag("state", t.is_resolved ? `resolved${t.resolved_by === null ? "" : ` by ${t.resolved_by}`}` : "unresolved", t.is_resolved ? C.dim : C.mod) +
        (t.is_outdated ? tag("", "outdated", C.mod) : "") +
        (t.subject_type === "FILE" ? tag("", "file comment") : ""),
    );
    const origin = t.comments[0]?.original_commit ?? null;
    const lines = [
      t.line === null ? null : `line ${t.line} at PR head`,
      t.original_line === null ? null : `line ${t.original_line} at ${origin === null ? "original commit" : origin.slice(0, 10)}`,
    ].filter((x) => x !== null);
    if (lines.length > 0) out.push(`${C.dim}${lines.join("   ")}`);
    if (t.comments_total > t.comments.length) out.push(`${C.mod}showing ${t.comments.length} of ${t.comments_total} comments`);
    out.push(...this.hunkRows(t, w));
    out.push(...this.section(`Conversation (${t.comments.length})`));
    t.comments.forEach((c, i) => {
      if (i > 0) out.push(`${C.faint}${"─".repeat(Math.min(w, PROSE_WIDTH))}`);
      const extra = [
        c.last_edited_at !== null ? "edited" : null,
        c.state === "PENDING" ? "pending" : null,
        c.is_minimized ? `hidden${c.minimized_reason === null ? "" : `: ${c.minimized_reason.toLowerCase()}`}` : null,
      ].filter((x) => x !== null);
      out.push(`${C.accent}${login(c.author)}${C.dim}  ${when(c.created_at)}${extra.length > 0 ? `  ${extra.join("  ")}` : ""}`);
      out.push(...this.body(c.body, w));
      out.push("");
    });
    const url = t.comments[0]?.url;
    if (url != null) out.push(`${C.faint}${url}`);
    return out;
  }

  private entryRows(e: ConversationEntry, w: number): string[] {
    const head = e.kind === "review" ? `review ${e.state?.toLowerCase().replace("_", " ") ?? ""}` : "comment";
    const out = wrapTextWithAnsi(`${C.text}${BOLD}${head}`, Math.min(w, PROSE_WIDTH));
    out.push("");
    const extra = [
      e.last_edited_at !== null ? "edited" : null,
      e.commit === null ? null : `at ${e.commit.slice(0, 10)}`,
      e.is_minimized ? `hidden${e.minimized_reason === null ? "" : `: ${e.minimized_reason.toLowerCase()}`}` : null,
    ].filter((x) => x !== null);
    out.push(`${C.accent}${login(e.author)}${C.dim}  ${when(e.created_at)}${extra.length > 0 ? `  ${extra.join("  ")}` : ""}`);
    out.push("");
    out.push(...this.body(e.body, w));
    out.push("");
    if (e.url !== null) out.push(`${C.faint}${e.url}`);
    return out;
  }

  private renderList(height: number, w: number): string[] {
    const s = this.opts.snapshot;
    type Row = { text: string; item: number | null };
    const rows: Row[] = [];
    const header = (label: string, count: number): void => {
      rows.push({ text: C.barBg + fit(` ${C.text}${BOLD}${label}${RESET}${C.barBg} ${C.dim}${count}`, w) + RESET, item: null });
    };
    const entry = (i: number, label: string, sub: string, body: string, dim: boolean): void => {
      const on = i === this.cursor;
      const base = on ? C.selBg : "";
      const marker = on ? `${C.accent}▎` : " ";
      rows.push({ text: base + fit(`${marker}${dim ? C.faint : on ? `${C.text}${BOLD}` : C.text}${label}`, w) + RESET, item: i });
      rows.push({ text: base + fit(`${marker}${sub}`, w) + RESET, item: i });
      for (const line of excerpt(body, w - 2)) rows.push({ text: base + fit(`${marker}${dim ? C.faint : C.dim}${line}`, w) + RESET, item: i });
      rows.push({ text: " ".repeat(w), item: i });
    };
    header("Code threads", s.threads.length);
    if (s.threads.length === 0) rows.push({ text: ` ${C.faint}no review threads`, item: null });
    this.items.forEach((item, i) => {
      if (item.kind !== "thread") return;
      const t = item.thread;
      const first = t.comments[0];
      const tags = threadTags(t);
      const tagText = tags.length === 0 ? "" : `${C.mod}${tags.join(" ")}  `;
      const sub = `${tagText}${C.dim}${first === undefined ? "" : login(first.author)} · ${t.comments.length}`;
      entry(i, tailPath(threadLocation(t), w - 1), sub, first?.body ?? "", t.is_resolved);
    });
    header("Conversation", s.conversation.length);
    if (s.conversation.length === 0) rows.push({ text: ` ${C.faint}no general comments`, item: null });
    this.items.forEach((item, i) => {
      if (item.kind !== "entry") return;
      const e = item.entry;
      const kind = e.kind === "review" ? `review ${e.state?.toLowerCase().replace("_", " ") ?? ""}` : "comment";
      entry(i, `${login(e.author)}  ${C.dim}${kind}`, `${C.dim}${when(e.created_at)}`, e.body, e.is_minimized);
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
    const s = this.opts.snapshot;
    const out: string[] = [];
    out.push(C.titleBg + fit(` ${C.text}${BOLD}github  #${s.pr.number}  ${s.pr.title}`, width) + RESET);
    const unresolved = s.threads.filter((t) => !t.is_resolved).length;
    const moved = this.opts.prHead !== undefined && this.opts.prHead !== s.pr.head_sha
      ? `   ${C.mod}PR head in station is ${this.opts.prHead.slice(0, 10)}` : "";
    const note = this.note === "" ? "" : `   ${C.mod}${this.note}`;
    out.push(
      C.barBg +
        fit(
          ` ${C.dim}fetched ${C.text}${when(s.fetched_at)}${C.dim}   head ${C.text}${s.pr.head_sha.slice(0, 10)}${C.dim}   ` +
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
      ? ` ${k("R", "fetch")}${k("↑/↓ ^↑/^↓", "item")}${k("⇧↑/⇧↓ pgup/pgdn", "scroll")}${k("e", "open")}${k("y", "copy link")}` +
        `${k("s", "sort")}${k("t", this.sidebar ? "hide list" : "show list")}${k("q", "quit")}`
      : truncateToWidth(` ${this.notice.error ? C.del : C.add}${this.notice.text}`, Math.max(1, width - visibleWidth(right) - 2), "…");
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    out.push(C.barBg + fit(`${left}${" ".repeat(gap)}${right}`, width) + RESET);
    return out;
  }
}

export interface FeedbackTabDeps {
  load: () => FeedbackSnapshot | null;
  fetch: () => Promise<FeedbackSnapshot>;
  save: (snapshot: FeedbackSnapshot) => void;
  fetchCommits: (shas: string[]) => Promise<void>;
}

export function defaultFeedbackDeps(host: PrTabHost): FeedbackTabDeps {
  const path = feedbackCachePath(host.repoSlug, host.pr);
  return {
    load: () => loadSnapshot(path),
    fetch: () => fetchFeedback(ghGraphql(host.repo), host.repoSlug, host.pr),
    save: (s) => saveSnapshot(path, s),
    fetchCommits: async (shas) => {
      await runAsync(host.repo, ["fetch", "-q", "--no-tags", "origin", ...shas]);
    },
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The github tab of a PR: shows the saved feedback snapshot and fetches from
 * GitHub only on R. Opening a thread resolves its revision and side-specific
 * line first and refuses locations it cannot verify.
 */
export class FeedbackTab implements TabScreen {
  private view: FeedbackView | null = null;
  private state: { kind: "none" } | { kind: "fetching" } | { kind: "error"; text: string } = { kind: "none" };
  private opening = false;

  constructor(
    private readonly host: PrTabHost,
    private readonly deps: FeedbackTabDeps = defaultFeedbackDeps(host),
  ) {
    try {
      const snapshot = deps.load();
      if (snapshot !== null) this.use(snapshot);
    } catch (e) {
      this.state = { kind: "error", text: `saved snapshot unreadable: ${errText(e)}` };
    }
  }

  private use(snapshot: FeedbackSnapshot): void {
    if (snapshot.pr.number !== this.host.pr) throw new Error(`snapshot is for #${snapshot.pr.number}, not #${this.host.pr}`);
    const next = new FeedbackView({
      snapshot,
      onQuit: this.host.onQuit,
      onOpen: (t) => void this.open(t, snapshot),
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

  private notice(): TabScreen {
    const n = this.host.pr;
    const body =
      this.state.kind === "fetching"
        ? ["fetching review threads and comments from GitHub…"]
        : this.state.kind === "error"
          ? [this.state.text, "", "R fetch again from GitHub"]
          : [
              `no GitHub feedback fetched for #${n} yet`,
              "",
              "R fetch review threads and PR comments from GitHub (read-only)",
              `  or from a shell: station github-feedback ${n} --save`,
            ];
    return new NoticeView({ title: `github  #${n}`, subtitle: prContext(this.host.repoSlug, n), body, onQuit: this.host.onQuit, hints: "R fetch" });
  }

  private setNote(text: string): void {
    if (this.view !== null) this.view.note = text;
    this.host.requestRender?.();
  }

  async refresh(): Promise<void> {
    if (this.state.kind === "fetching") return;
    this.state = { kind: "fetching" };
    this.setNote("fetching from GitHub…");
    try {
      const snapshot = await this.deps.fetch();
      this.use(snapshot);
      this.state = { kind: "none" };
      try {
        this.deps.save(snapshot);
        this.setNote("");
      } catch (e) {
        this.setNote(`not saved: ${errText(e)}`);
      }
    } catch (e) {
      const text = `fetch failed: ${errText(e)}`;
      this.state = { kind: "error", text };
      this.setNote(this.view === null ? "" : "fetch failed, showing the previous snapshot");
      if (this.view !== null) this.host.showPopup({ title: "github", text, error: true, footer: "any key" }, true);
    }
    this.host.requestRender?.();
  }

  async open(thread: ReviewThread, snapshot: FeedbackSnapshot): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    const fail = (text: string): void =>
      this.host.showPopup({ title: "open", text: `${text}\n\nThe captured diff stays in the detail view.`, error: true, footer: "any key" }, true);
    try {
      const git = localGit(this.host.repo);
      const missing = [...new Set(requiredCommits(thread, snapshot))].filter((s) => !git.hasCommit(s));
      if (missing.length > 0) {
        this.setNote(`fetching ${missing.map((s) => s.slice(0, 10)).join(" ")} from origin…`);
        await this.deps.fetchCommits(missing).catch(() => undefined);
        this.setNote("");
      }
      const loc = resolveThread(thread, snapshot, git);
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
