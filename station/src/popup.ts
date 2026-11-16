import {
  type Component,
  Editor,
  type EditorTheme,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { BOLD, C, RESET } from "./changes.js";

const PAD_X = 3;
const MAX_WIDTH = 72;

export interface PopupContent {
  title: string;
  text: string;
  error?: boolean;
  footer?: string;
}

export class Popup implements Component {
  constructor(public content: PopupContent) {}

  invalidate(): void {}

  render(width: number): string[] {
    const { title, text, error, footer } = this.content;
    const inner = Math.max(1, width - 2 - 2 * PAD_X);
    const border = (s: string): string => `${C.faint}${s}${RESET}`;
    const head = ` ${title} `;
    const foot = footer === undefined ? "" : ` ${footer} `;
    const top =
      border("╭─") + `${C.accent}${BOLD}${head}${RESET}` + border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(head)))}╮`);
    const bottom =
      border(`╰${"─".repeat(Math.max(0, width - 3 - visibleWidth(foot)))}`) + `${C.dim}${foot}${RESET}` + border("─╯");
    const row = (s: string): string => {
      const cut = truncateToWidth(s, inner, "…");
      const pad = " ".repeat(PAD_X);
      return border("│") + pad + cut + RESET + " ".repeat(Math.max(0, inner - visibleWidth(cut))) + pad + border("│");
    };
    const body = wrapTextWithAnsi(`${error === true ? C.del : C.text}${text}`, inner);
    return [top, row(""), ...body.map(row), row(""), bottom].map((l) => truncateToWidth(l, width));
  }
}

const plain = (s: string): string => s;

const editorTheme: EditorTheme = {
  borderColor: (s) => `${C.faint}${s}${RESET}`,
  selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
};

export class ComposeBox implements Component {
  readonly editor: Editor;

  constructor(
    tui: TUI,
    private readonly title: string,
    text: string,
  ) {
    this.editor = new Editor(tui, editorTheme, { paddingX: 1 });
    this.editor.setText(text);
    this.editor.focused = true;
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  render(width: number): string[] {
    const head = C.titleBg + truncateToWidth(` ${C.text}${BOLD}comment${RESET}${C.titleBg} ${C.dim}${this.title}`, width, "…", true) + RESET;
    const keys = ` ${C.text}enter${C.dim} save  ${C.text}shift+enter${C.dim} newline  ${C.text}esc${C.dim} cancel`;
    const foot = C.barBg + truncateToWidth(keys, width, "", true) + RESET;
    return [head, ...this.editor.render(width).map((l) => C.barBg + truncateToWidth(l, width, "", true) + RESET), foot];
  }
}

export function popupWidth(): number {
  return Math.min(MAX_WIDTH, Math.max(30, Math.floor((process.stdout.columns ?? 80) * 0.7)));
}

export const backdrop: Component = {
  render: (width) => Array(process.stdout.rows ?? 40).fill(" ".repeat(width)),
  invalidate: () => {},
};
