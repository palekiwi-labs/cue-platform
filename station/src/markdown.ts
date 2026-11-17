import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { BOLD, C, RESET } from "./changes.js";
import { highlightLines } from "./highlight.js";

const paint = (color: string) => (t: string): string => `${color}${t}${C.text}`;

export const theme: MarkdownTheme = {
  heading: (t) => `${C.accent}${BOLD}${t}${RESET}${C.text}`,
  link: paint(C.accent),
  linkUrl: paint(C.dim),
  code: paint(C.mod),
  codeBlock: paint(C.text),
  codeBlockBorder: paint(C.faint),
  quote: paint(C.dim),
  quoteBorder: paint(C.faint),
  hr: paint(C.faint),
  listBullet: paint(C.accent),
  bold: (t) => `${BOLD}${t}\x1b[22m`,
  italic: (t) => `\x1b[3m${t}\x1b[23m`,
  strikethrough: (t) => `\x1b[9m${t}\x1b[29m`,
  underline: (t) => `\x1b[4m${t}\x1b[24m`,
  highlightCode: (code, lang) => {
    if (lang === undefined || lang === "") return code.split("\n").map((l) => `${C.text}${l}`);
    try {
      return highlightLines(code, lang);
    } catch {
      return code.split("\n").map((l) => `${C.text}${l}`);
    }
  },
};

export function markdownRows(text: string, width: number): string[] {
  if (text.trim() === "") return [];
  return new Markdown(text, 0, 0, theme, { color: (t) => `${C.text}${t}` }).render(width);
}
