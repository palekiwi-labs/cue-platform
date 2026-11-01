// Colours copied from pi's dark theme:
// earendil-works/pi packages/coding-agent/src/modes/interactive/theme/dark.json
// (commit d5b3de22d), MIT licensed, Copyright (c) Earendil Works.
import {
  type Color,
  getTerminalColorMode,
  type MarkdownTheme,
  parseColor,
  styleText,
  type TextAttributes,
} from "@earendil-works/pi-tui";
import type { Theme } from "./picker/prs/ui.js";

const palette = {
  text: "okhsl(234 3% 89%)",
  accent: "okhsl(295 50% 67%)",
  muted: "okhsl(229 6% 67%)",
  dim: "okhsl(229 8% 56%)",
  success: "okhsl(159 59% 67%)",
  error: "okhsl(20 72% 67%)",
  warning: "okhsl(83 88% 67%)",
  border: "okhsl(229 8% 40%)",
  selectedBg: "okhsl(275 15% 26%)",
} as const;

export type ThemeColor = keyof typeof palette;

const colors = Object.fromEntries(
  Object.entries(palette).map(([key, value]) => [key, parseColor(value)]),
) as Record<ThemeColor, Color>;

export function fg(color: ThemeColor, text: string, attrs: TextAttributes = {}): string {
  return styleText(text, { ...attrs, fg: colors[color] }, getTerminalColorMode());
}

export function bold(text: string): string {
  return styleText(text, { bold: true }, getTerminalColorMode());
}

function isThemeColor(color: string): color is ThemeColor {
  return Object.hasOwn(palette, color);
}

/** The structural theme the shared PR picker renders through. */
export const pickerTheme: Theme = {
  fg: (color, text) => (isThemeColor(color) ? fg(color, text) : text),
  bg: (color, text) =>
    isThemeColor(color)
      ? styleText(text, { bg: colors[color] }, getTerminalColorMode())
      : text,
  bold,
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => fg("warning", text, { bold: true }),
  link: (text) => fg("accent", text),
  linkUrl: (text) => fg("dim", text),
  code: (text) => fg("accent", text),
  codeBlock: (text) => fg("success", text),
  codeBlockBorder: (text) => fg("muted", text),
  quote: (text) => fg("muted", text),
  quoteBorder: (text) => fg("muted", text),
  hr: (text) => fg("muted", text),
  listBullet: (text) => fg("accent", text),
  bold: (text) => styleText(text, { bold: true }, getTerminalColorMode()),
  italic: (text) => styleText(text, { italic: true }, getTerminalColorMode()),
  strikethrough: (text) =>
    styleText(text, { strikethrough: true }, getTerminalColorMode()),
  underline: (text) =>
    styleText(text, { underline: true }, getTerminalColorMode()),
};
