import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Component, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { BOLD, C, fit, RESET } from "./changes.js";
import { catFiles, run } from "./git.js";
import { highlightFile } from "./highlight.js";

export interface Finding {
  id: string;
  title: string;
  severity: string;
  confidence: string | null;
  category: string | null;
  status: string | null;
  dismiss_reason: string | null;
  file: string | null;
  line_start: number | null;
  line_end: number | null;
  snippet: string | null;
  message: string;
  suggested_fix: string | null;
  verification: { verdict: string; reasoning: string } | null;
}

export interface FindingsRun {
  address: string;
  runId: string;
  context: string;
  subject: string;
  base: string;
  head: string;
  source: string;
  summary: Record<string, unknown>;
  analysis: Record<string, unknown>;
  findings: Finding[];
}

export interface CodeExcerpt {
  start: number;
  lines: string[];
}

const SEVERITY = ["critical", "high", "medium", "low", "info"];
const CONTEXT_LINES = 3;
const PROSE_WIDTH = 80;

export function severityRank(s: string): number {
  const i = SEVERITY.indexOf(s.toLowerCase());
  return i === -1 ? SEVERITY.length : i;
}

export function sortFindings(findings: Finding[]): Finding[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => severityRank(a.f.severity) - severityRank(b.f.severity) || a.i - b.i)
    .map(({ f }) => f);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function parseFinding(raw: unknown, index: number): Finding {
  const o = obj(raw);
  const v = obj(o.verification);
  const verdict = str(v.verdict);
  return {
    id: str(o.id) ?? `finding-${index + 1}`,
    title: str(o.title) ?? "(untitled)",
    severity: str(o.severity) ?? "unknown",
    confidence: str(o.confidence),
    category: str(o.category),
    status: str(o.status),
    dismiss_reason: str(o.dismiss_reason),
    file: str(o.file),
    line_start: int(o.line_start),
    line_end: int(o.line_end),
    snippet: str(o.snippet),
    message: str(o.message) ?? "",
    suggested_fix: str(o.suggested_fix),
    verification: verdict === null ? null : { verdict, reasoning: str(v.reasoning) ?? "" },
  };
}

export function storeRoot(): string {
  return process.env.CUE_STORE ?? join(homedir(), "cue");
}

export function runDir(address: string, store = storeRoot()): string {
  const clean = address.replace(/\/+$/, "");
  if (!/^[^/]+\/[^/]+\/[^/]+\/review\/runs\/[^/]+$/.test(clean) || clean.split("/").includes("..")) {
    throw new Error(`not a review run address (<org>/<repo>/<context>/review/runs/<run_id>): ${address}`);
  }
  return join(store, clean);
}

export function loadRun(address: string, store = storeRoot()): FindingsRun {
  const dir = runDir(address, store);
  const runPath = join(dir, "run.json");
  if (!existsSync(runPath)) throw new Error(`no run.json in ${address}`);
  const meta = obj(JSON.parse(readFileSync(runPath, "utf8")));
  const head = str(meta.head);
  if (head === null) throw new Error(`run.json has no head sha: ${address}`);
  const verifiers = readdirSync(dir).filter((n) => /^verifiers-.+\.json$/.test(n)).sort();
  const source = verifiers[0];
  if (source === undefined) {
    throw new Error(`run has no verified findings yet (state: ${str(meta.state) ?? "unknown"}): ${address}`);
  }
  const data = obj(JSON.parse(readFileSync(join(dir, source), "utf8")));
  const raw = Array.isArray(data.findings) ? data.findings : [];
  const target = obj(meta.target);
  const runId = address.replace(/\/+$/, "").split("/").pop() ?? "";
  return {
    address,
    runId,
    context: str(meta.context) ?? address.split("/").slice(0, 3).join("/"),
    subject: str(target.subject) ?? str(target.refs) ?? "",
    base: str(meta.base) ?? "",
    head,
    source,
    summary: obj(data.summary),
    analysis: obj(data.analysis),
    findings: sortFindings(raw.map(parseFinding)),
  };
}

export function excerpt(source: string, start: number, end: number, context = CONTEXT_LINES): CodeExcerpt {
  const all = source.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const from = Math.max(1, Math.min(start, end) - context);
  const to = Math.min(all.length, Math.max(start, end) + context);
  return { start: from, lines: all.slice(from - 1, to) };
}

export function headInRepo(repoPath: string, head: string): boolean {
  try {
    run(repoPath, ["cat-file", "-e", `${head}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function loadSources(repoPath: string, head: string, files: string[]): Map<string, string | null> {
  const unique = [...new Set(files)];
  const blobs = catFiles(repoPath, unique.map((f) => `${head}:${f}`));
  return new Map(unique.map((f, i) => [f, blobs[i] ?? null]));
}

export interface FindingsOptions {
  run: FindingsRun;
  sources: Map<string, string | null>;
  onQuit: () => void;
  onOpen: (file: string, line: number) => void;
}

function severityColor(s: string): string {
  switch (s.toLowerCase()) {
    case "critical":
    case "high":
      return C.del;
    case "medium":
      return C.mod;
    case "low":
      return C.ren;
    default:
      return C.dim;
  }
}

function lines(f: Finding): string {
  if (f.line_start === null) return "";
  return f.line_end === null || f.line_end === f.line_start ? `${f.line_start}` : `${f.line_start}-${f.line_end}`;
}

function location(f: Finding): string {
  if (f.file === null) return "(no file)";
  const l = lines(f);
  return l === "" ? f.file : `${f.file}:${l}`;
}

export class FindingsView implements Component {
  private cursor = 0;
  private offset = 0;
  private listOffset = 0;
  private lastHeight = 20;
  private readonly highlighted = new Map<string, string[] | null>();

  constructor(private readonly opts: FindingsOptions) {}

  invalidate(): void {}

  private current(): Finding | undefined {
    return this.opts.run.findings[this.cursor];
  }

  private count(): number {
    return this.opts.run.findings.length;
  }

  private move(delta: number): void {
    const n = this.count();
    if (n === 0) return;
    this.cursor = (this.cursor + delta + n) % n;
    this.offset = 0;
  }

  handleInput(data: string): void {
    const h = this.lastHeight;
    if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
      this.offset += Math.floor(h / 2);
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
      this.offset -= Math.floor(h / 2);
      return;
    }
    if (matchesKey(data, "shift+down")) {
      this.offset += 3;
      return;
    }
    if (matchesKey(data, "shift+up")) {
      this.offset -= 3;
      return;
    }
    switch (data) {
      case "q":
      case "\x03":
        this.opts.onQuit();
        return;
      case "j":
      case "\x1b[B":
        this.move(1);
        return;
      case "k":
      case "\x1b[A":
        this.move(-1);
        return;
      case "g":
        this.cursor = 0;
        this.offset = 0;
        return;
      case "G":
        this.cursor = Math.max(0, this.count() - 1);
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
        const f = this.current();
        if (f?.file != null) this.opts.onOpen(f.file, f.line_start ?? 1);
        return;
      }
      default:
        return;
    }
  }

  private highlightedSource(file: string): string[] | null {
    if (this.highlighted.has(file)) return this.highlighted.get(file) ?? null;
    const src = this.opts.sources.get(file) ?? null;
    const lines = src === null ? null : (highlightFile(file, { old: null, new: src })?.new ?? null);
    this.highlighted.set(file, lines);
    return lines;
  }

  private section(title: string, body: string, w: number): string[] {
    const out = ["", `${C.accent}${BOLD}${title}${RESET}`, ""];
    const pw = Math.min(w, PROSE_WIDTH);
    for (const para of body.split("\n")) out.push(...wrapTextWithAnsi(`${C.text}${para}`, pw));
    return out;
  }

  private codeRows(f: Finding, w: number): string[] {
    const head = `${C.accent}${BOLD}Code${RESET} ${C.dim}at ${this.opts.run.head.slice(0, 10)}`;
    if (f.file === null || f.line_start === null) return ["", head, "", `${C.faint}no file or line range`];
    const src = this.opts.sources.get(f.file) ?? null;
    if (src === null) {
      const out = ["", head, "", `${C.del}${f.file} not found at head`];
      if (f.snippet !== null) out.push(...f.snippet.split("\n").map((l) => `${C.dim}  ${l}`));
      return out;
    }
    const start = f.line_start;
    const end = f.line_end ?? start;
    const ex = excerpt(src, start, end);
    const hl = this.highlightedSource(f.file);
    const out = ["", head, ""];
    ex.lines.forEach((text, i) => {
      const n = ex.start + i;
      const inRange = n >= Math.min(start, end) && n <= Math.max(start, end);
      const code = (hl?.[n - 1] ?? text).replaceAll("\x1b[39m", C.text);
      const gutter = inRange ? `${C.selBg}${C.accent}${String(n).padStart(5)} ▎` : `${C.faint}${String(n).padStart(5)}  `;
      out.push(gutter + RESET + (inRange ? C.selBg : "") + fit(`${C.text}${code}`, w - 7) + RESET);
    });
    return out;
  }

  private findingRows(f: Finding, w: number): string[] {
    const out: string[] = [];
    out.push(...wrapTextWithAnsi(`${C.text}${BOLD}${f.title}`, Math.min(w, PROSE_WIDTH)));
    out.push("");
    const tag = (label: string, value: string | null, color = C.text): string =>
      value === null ? "" : `${C.dim}${label} ${color}${value}${RESET}   `;
    out.push(
      tag("severity", f.severity, severityColor(f.severity)) +
        tag("confidence", f.confidence) +
        tag("category", f.category) +
        tag("verdict", f.verification?.verdict ?? null) +
        tag("status", f.status),
    );
    out.push(`${C.dim}${f.id}  ${C.text}${location(f)}`);
    if (f.dismiss_reason !== null) out.push(`${C.mod}dismissed: ${f.dismiss_reason}`);
    out.push(...this.section("Message", f.message, w));
    out.push(...this.codeRows(f, w));
    if (f.suggested_fix !== null) out.push(...this.section("Suggested fix", f.suggested_fix, w));
    if (f.verification !== null) {
      out.push(...this.section(`Verification: ${f.verification.verdict}`, f.verification.reasoning, w));
    }
    out.push("");
    return out;
  }

  private renderList(height: number, w: number): string[] {
    const r = this.opts.run;
    const out: string[] = [];
    out.push(C.barBg + fit(` ${C.text}${BOLD}Findings${RESET}${C.barBg} ${C.dim}${r.findings.length}`, w) + RESET);
    const entries = r.findings.map((f) => ({
      label: f.title,
      sub: `${severityColor(f.severity)}${f.severity.toUpperCase()}  ${C.dim}${location(f)}`,
    }));
    if (entries.length === 0) out.push(` ${C.faint}no findings`);
    const per = 3;
    const listH = Math.max(1, Math.floor((height - 1) / per));
    if (this.cursor < this.listOffset) this.listOffset = this.cursor;
    if (this.cursor >= this.listOffset + listH) this.listOffset = this.cursor - listH + 1;
    for (let i = this.listOffset; i < entries.length && out.length + per <= height; i++) {
      const e = entries[i] as (typeof entries)[number];
      const on = i === this.cursor;
      const base = on ? C.selBg : "";
      const marker = on ? `${C.accent}▎` : " ";
      out.push(base + fit(`${marker}${on ? `${C.text}${BOLD}` : C.text}${e.label}`, w) + RESET);
      out.push(base + fit(`${marker}${e.sub}`, w) + RESET);
      out.push(" ".repeat(w));
    }
    while (out.length < height) out.push(" ".repeat(w));
    return out;
  }

  render(width: number): string[] {
    const total = Math.max(8, process.stdout.rows ?? 40);
    const bodyH = total - 3;
    this.lastHeight = bodyH;
    const r = this.opts.run;
    const out: string[] = [];
    out.push(C.titleBg + fit(` ${C.text}${BOLD}findings  ${r.subject}`, width) + RESET);
    const bySeverity = obj(r.summary.by_severity);
    const counts = SEVERITY.filter((s) => typeof bySeverity[s] === "number" && (bySeverity[s] as number) > 0)
      .map((s) => `${severityColor(s)}${String(bySeverity[s])} ${s}`)
      .join(`${C.dim}  `);
    out.push(C.barBg + fit(` ${C.dim}${r.context}   head ${C.text}${r.head.slice(0, 10)}   ${counts}`, width) + RESET);

    const sideW = Math.min(56, Math.max(28, Math.floor(width * 0.34)));
    const mainW = width - sideW - 1;
    const pad = 2;
    const finding = this.current();
    const rows = finding !== undefined ? this.findingRows(finding, mainW - pad) : [];
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - bodyH)));
    const side = this.renderList(bodyH, sideW);
    for (let i = 0; i < bodyH; i++) {
      const row = rows[this.offset + i] ?? "";
      out.push(`${fit(" ".repeat(pad) + truncateToWidth(row, mainW - pad, ""), mainW)}${RESET}${C.faint}│${RESET}${side[i] ?? ""}`);
    }

    const k = (key: string, what: string): string => `${C.text}${key}${C.dim} ${what}  `;
    const keys = ` ${k("↑/↓", "finding")}${k("shift-↑/↓ pgup/pgdn", "scroll")}${k("e", "open")}${k("q", "quit")}`;
    const more = this.offset + bodyH < rows.length ? `${C.accent}more ↓  ` : "";
    const pos = r.findings.length === 0 ? "" : `finding ${this.cursor + 1}/${r.findings.length} `;
    const right = `${more}${C.dim}${pos}`;
    const gap = Math.max(1, width - visibleWidth(keys) - visibleWidth(right));
    out.push(C.barBg + fit(`${keys}${" ".repeat(gap)}${right}`, width) + RESET);
    return out;
  }
}
