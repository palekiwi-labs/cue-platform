import { statSync } from "node:fs";
import { basename, join } from "node:path";

/** Directories holding `<owner>/<name>` checkouts, searched in order. */
export function checkoutRoots(home: string): string[] {
  return ["palekiwi", "palekiwi-labs", "spabreaks", "vendor"].map((dir) =>
    join(home, "code", dir),
  );
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The local checkout of an `owner/name` repo: `<root>/<owner>/<name>`, or
 * `<root>/<name>` when the root is the owner's directory. First match wins.
 */
export function findCheckout(
  repo: string,
  roots: string[],
  isDir: (path: string) => boolean = isDirectory,
): string | undefined {
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length > 0) return undefined;
  for (const root of roots) {
    const candidates = [join(root, owner, name)];
    if (basename(root) === owner) candidates.unshift(join(root, name));
    const path = candidates.find(isDir);
    if (path) return path;
  }
  return undefined;
}
