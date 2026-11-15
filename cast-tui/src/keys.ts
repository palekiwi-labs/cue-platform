import { matchesKey } from "@earendil-works/pi-tui";

export function isQuitKey(data: string): boolean {
  return matchesKey(data, "q") || matchesKey(data, "ctrl+c");
}

export function isPickerKey(data: string): boolean {
  return matchesKey(data, "shift+p");
}
