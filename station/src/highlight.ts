import { basename, extname } from "node:path";
import hljs from "highlight.js";

const fg = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`;
const DEFAULT_FG = "\x1b[39m";
const MAX_BYTES = 512 * 1024;

const SCOPES: Record<string, string> = {
  keyword: fg(255, 123, 114),
  built_in: fg(255, 166, 87),
  type: fg(255, 166, 87),
  literal: fg(121, 192, 255),
  number: fg(121, 192, 255),
  string: fg(165, 214, 255),
  regexp: fg(165, 214, 255),
  symbol: fg(121, 192, 255),
  comment: fg(139, 148, 158),
  doc: fg(139, 148, 158),
  meta: fg(139, 148, 158),
  title: fg(210, 168, 255),
  "title.class": fg(255, 166, 87),
  "title.function": fg(210, 168, 255),
  params: fg(220, 223, 228),
  attr: fg(121, 192, 255),
  attribute: fg(121, 192, 255),
  variable: fg(255, 166, 87),
  property: fg(121, 192, 255),
  tag: fg(126, 231, 135),
  name: fg(126, 231, 135),
  "selector-tag": fg(126, 231, 135),
  "selector-class": fg(210, 168, 255),
  subst: fg(220, 223, 228),
  addition: fg(126, 231, 135),
  deletion: fg(255, 123, 114),
  section: fg(121, 192, 255),
};

const NAMES: Record<string, string> = {
  Gemfile: "ruby",
  Rakefile: "ruby",
  Dockerfile: "dockerfile",
  Makefile: "makefile",
};

const EXTS: Record<string, string> = {
  ".erb": "erb",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".jbuilder": "ruby",
  ".tsx": "typescript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".lock": "",
};

export function languageFor(path: string): string | null {
  const name = basename(path);
  const byName = NAMES[name];
  if (byName !== undefined) return byName;
  const ext = extname(name);
  const byExt = EXTS[ext];
  if (byExt !== undefined) return byExt === "" ? null : byExt;
  if (ext === "") return null;
  const lang = ext.slice(1);
  return hljs.getLanguage(lang) !== undefined ? lang : null;
}

function scopeColor(cls: string): string | undefined {
  const scope = cls.replace(/^hljs-/, "").split(" ")[0] ?? "";
  return SCOPES[scope] ?? SCOPES[scope.split(".")[0] ?? ""];
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Highlights source and returns one string per line, coloured with
 * foreground-only escapes so the caller's background survives.
 */
export function highlightLines(code: string, lang: string): string[] {
  const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  const lines: string[] = [];
  const stack: string[] = [];
  let line = "";
  const active = (): string => stack[stack.length - 1] ?? DEFAULT_FG;
  for (const part of html.split(/(<span class="[^"]*">|<\/span>)/)) {
    if (part.startsWith("<span")) {
      const cls = part.slice(13, -2);
      stack.push(scopeColor(cls) ?? active());
      line += active();
    } else if (part === "</span>") {
      stack.pop();
      line += active();
    } else if (part !== "") {
      const pieces = decode(part).split("\n");
      pieces.forEach((p, i) => {
        if (i > 0) {
          lines.push(line + DEFAULT_FG);
          line = active();
        }
        line += p;
      });
    }
  }
  lines.push(line + DEFAULT_FG);
  return lines;
}

export interface FileSources {
  old: string | null;
  new: string | null;
}

export type Highlights = Map<string, { old: string[] | null; new: string[] | null }>;

export function highlightFile(path: string, src: FileSources): { old: string[] | null; new: string[] | null } | null {
  const lang = languageFor(path);
  if (lang === null) return null;
  const one = (s: string | null): string[] | null => {
    if (s === null || s.length > MAX_BYTES || s.includes("\0")) return null;
    try {
      return highlightLines(s, lang);
    } catch {
      return null;
    }
  };
  return { old: one(src.old), new: one(src.new) };
}
