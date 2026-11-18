export interface Revision {
  storeId: string;
  revision: number;
}

export function newer(next: Revision, shown: Revision | null): boolean {
  return shown === null || next.storeId !== shown.storeId || next.revision > shown.revision;
}

function older(next: Revision, shown: Revision | null): boolean {
  return shown !== null && next.storeId === shown.storeId && next.revision < shown.revision;
}

type Mode = "notify" | "reconcile" | "always";

const RANK: Record<Mode, number> = { notify: 0, reconcile: 1, always: 2 };

export interface ReloaderOptions<T> {
  read: () => Promise<T>;
  revision: (data: T) => Revision;
  apply: (data: T, changed: boolean, previous: Revision | null) => void;
  fail: (error: unknown) => void;
}

/**
 * Serializes reads of a revisioned service snapshot. At most one read runs at
 * a time; requests made meanwhile coalesce into one follow-up read, and a
 * notification is dropped when the shown revision already covers it.
 * Responses older than the shown revision are never applied.
 */
export class Reloader<T> {
  private current: Revision | null = null;
  private target: Revision | null = null;
  private pending: Mode | null = null;
  private waiting: (() => void)[] = [];
  private running = false;
  private closed = false;

  constructor(private readonly opts: ReloaderOptions<T>) {}

  get shown(): Revision | null {
    return this.current;
  }

  /** Reads only if `revision` is newer than the shown data. */
  notify(revision: Revision): Promise<void> {
    if (!newer(revision, this.current)) return Promise.resolve();
    if (this.target === null || newer(revision, this.target)) this.target = revision;
    return this.request("notify");
  }

  /** Reads and applies the result only if it differs from the shown data. */
  reconcile(): Promise<void> {
    return this.request("reconcile");
  }

  /** Reads and applies the result unless it is older than the shown data. */
  reload(): Promise<void> {
    return this.request("always");
  }

  close(): void {
    this.closed = true;
    this.pending = null;
    for (const done of this.waiting.splice(0)) done();
  }

  private request(mode: Mode): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending === null || RANK[mode] > RANK[this.pending]) this.pending = mode;
    const done = new Promise<void>((resolve) => this.waiting.push(resolve));
    if (!this.running) void this.drain();
    return done;
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.pending !== null && !this.closed) {
        const mode = this.pending;
        const batch = this.waiting.splice(0);
        this.pending = null;
        try {
          await this.step(mode);
        } finally {
          for (const done of batch) done();
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async step(mode: Mode): Promise<void> {
    if (mode === "notify" && (this.target === null || !newer(this.target, this.current))) return;
    try {
      const data = await this.opts.read();
      if (this.closed) return;
      const revision = this.opts.revision(data);
      const changed = newer(revision, this.current);
      if (older(revision, this.current) || (!changed && mode !== "always")) return;
      const previous = this.current;
      this.opts.apply(data, changed, previous);
      this.current = revision;
    } catch (e) {
      if (!this.closed) this.opts.fail(e);
    }
  }
}

/**
 * Walks outward from position `from` of `previous`, later entries first at
 * equal distance, and returns the first index `find` locates; -1 when none.
 */
export function nearestSurvivor<T>(previous: readonly T[], from: number, find: (item: T) => number): number {
  for (let d = 1; d < previous.length; d++) {
    for (const i of [from + d, from - d]) {
      const item = previous[i];
      if (item === undefined) continue;
      const index = find(item);
      if (index >= 0) return index;
    }
  }
  return -1;
}
