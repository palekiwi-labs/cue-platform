const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

export function colorHunkLine(line: string, selected: boolean): string {
  if (selected) return `\x1b[7m${line}${RESET}`;
  if (line.startsWith("@@")) return `${CYAN}${BOLD}${line}${RESET}`;
  if (line.startsWith("+")) return `${GREEN}${line}${RESET}`;
  if (line.startsWith("-")) return `${RED}${line}${RESET}`;
  return `${DIM}${line}${RESET}`;
}

export function plainHunkLine(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}
