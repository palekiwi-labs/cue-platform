import { randomUUID } from "node:crypto";
import type {
  ChangedEvent,
  CompletedEvent,
  Pr,
  RefreshOperation,
} from "./protocol.js";
import { SnapshotStore } from "./store.js";

export class ServiceError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "not_found"
      | "conflict"
      | "busy"
      | "unavailable",
    message: string,
  ) {
    super(message);
  }
}
type Outcome = RefreshOperation["repositories"][string];
interface Job {
  repo: string;
  due: number;
  promise: Promise<Outcome>;
  resolve: (value: Outcome) => void;
}
export interface ServiceOptions {
  pollMs?: number;
  concurrency?: number;
  cooldownMs?: number;
  staggerMs?: number;
  maxBackoffMs?: number;
  operationTtlMs?: number;
  maxOperations?: number;
  now?: () => number;
}
export interface ServiceEvents {
  changed: ChangedEvent;
  completed: CompletedEvent;
}
export type FetchRepository = (
  repo: string,
  signal: AbortSignal,
) => Promise<{ viewer: string; prs: Pr[] }>;

export class GithubService {
  readonly options: Required<ServiceOptions>;
  private jobs = new Map<string, Job>();
  private running = new Set<Promise<void>>();
  private nextPoll = new Map<string, number>();
  private operations = new Map<string, RefreshOperation>();
  private listeners = new Set<
    (subject: keyof ServiceEvents, event: ChangedEvent | CompletedEvent) => void
  >();
  private abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    readonly store: SnapshotStore,
    private fetch: FetchRepository,
    options: ServiceOptions = {},
  ) {
    this.options = {
      pollMs: 120_000,
      concurrency: 2,
      cooldownMs: 15_000,
      staggerMs: 1_000,
      maxBackoffMs: 1_800_000,
      operationTtlMs: 900_000,
      maxOperations: 256,
      now: Date.now,
      ...options,
    };
    store.repos.forEach((repo, index) =>
      this.nextPoll.set(
        repo,
        Math.max(
          this.options.now() + index * this.options.staggerMs,
          this.allowedAt(repo),
        ),
      ),
    );
  }

  private delay(failures: number): number {
    return Math.max(
      this.options.cooldownMs,
      failures
        ? Math.min(
            this.options.maxBackoffMs,
            this.options.pollMs * 2 ** Math.min(failures - 1, 20),
          )
        : this.options.cooldownMs,
    );
  }
  private allowedAt(repo: string): number {
    const s = this.store.read(repo).snapshot;
    return s.attemptedAt === null ? 0 : s.attemptedAt + this.delay(s.failures);
  }
  onEvent(
    listener: (
      subject: keyof ServiceEvents,
      event: ChangedEvent | CompletedEvent,
    ) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(
    subject: keyof ServiceEvents,
    event: ChangedEvent | CompletedEvent,
  ): void {
    for (const listener of this.listeners) {
      try {
        listener(subject, event);
      } catch {}
    }
  }
  select(repo?: string): readonly string[] {
    if (repo === undefined) return this.store.repos;
    if (!this.store.repos.includes(repo))
      throw new ServiceError("invalid_request", "repository is not configured");
    return [repo];
  }
  private prune(): void {
    const now = this.options.now();
    for (const [id, op] of this.operations) {
      if (
        op.completedAt !== null &&
        now - op.completedAt >= this.options.operationTtlMs
      )
        this.operations.delete(id);
    }
  }
  refresh(repo?: string): { operationId: string } {
    if (this.abort.signal.aborted)
      throw new ServiceError("unavailable", "service is stopping");
    const repos = this.select(repo);
    this.prune();
    while (this.operations.size >= this.options.maxOperations) {
      const completed = [...this.operations].find(
        ([, op]) => op.state === "complete",
      );
      if (!completed)
        throw new ServiceError("busy", "operation capacity reached");
      this.operations.delete(completed[0]);
    }
    const operationId = randomUUID();
    const op: RefreshOperation = {
      operationId,
      createdAt: this.options.now(),
      completedAt: null,
      state: "pending",
      repositories: Object.fromEntries(
        repos.map((r) => [r, { state: "pending" }]),
      ),
    };
    this.operations.set(operationId, op);
    void Promise.all(
      repos.map(async (r) => {
        op.repositories[r] = await this.enqueue(r);
      }),
    ).then(() => {
      op.state = "complete";
      op.completedAt = this.options.now();
      this.emit("completed", { operationId });
    });
    this.pump();
    return { operationId };
  }
  operation(id: string): RefreshOperation {
    this.prune();
    const op = this.operations.get(id);
    if (!op)
      throw new ServiceError(
        "not_found",
        "operation expired, evicted or unknown",
      );
    return structuredClone(op);
  }
  private enqueue(repo: string): Promise<Outcome> {
    const existing = this.jobs.get(repo);
    if (existing) return existing.promise;
    let resolve!: (value: Outcome) => void;
    const promise = new Promise<Outcome>((r) => {
      resolve = r;
    });
    this.jobs.set(repo, { repo, due: this.allowedAt(repo), promise, resolve });
    return promise;
  }
  tick(): void {
    if (this.abort.signal.aborted) return;
    this.prune();
    for (const [repo, due] of this.nextPoll) {
      if (due <= this.options.now()) void this.enqueue(repo);
    }
    this.pump();
  }
  start(): void {
    if (this.timer || this.abort.signal.aborted) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 250);
  }
  private pump(): void {
    if (this.abort.signal.aborted) return;
    for (const job of this.jobs.values()) {
      if (this.running.size >= this.options.concurrency) break;
      if (job.due > this.options.now()) continue;
      job.due = Infinity;
      const task = this.run(job).finally(() => {
        this.running.delete(task);
        this.pump();
      });
      this.running.add(task);
    }
  }
  private async run(job: Job): Promise<void> {
    let outcome: Outcome;
    let failures = 1;
    try {
      this.store.attempted(job.repo, this.options.now());
      const result = await this.fetch(job.repo, this.abort.signal);
      if (this.abort.signal.aborted) throw new Error("stopping");
      const saved = this.store.replace(
        job.repo,
        result.viewer,
        result.prs,
        this.options.now(),
      );
      outcome = { state: "success", ...saved };
      failures = 0;
      if (saved.changed)
        this.emit("changed", {
          storeId: this.store.storeId,
          repo: job.repo,
          revision: saved.revision,
        });
    } catch {
      try {
        this.store.failed(job.repo, this.options.now());
        failures = this.store.read(job.repo).snapshot.failures;
      } catch {}
      outcome = { state: "error", error: "GitHub collection failed" };
    }
    this.nextPoll.set(
      job.repo,
      this.options.now() +
        (failures ? this.delay(failures) : this.options.pollMs),
    );
    this.jobs.delete(job.repo);
    job.resolve(outcome);
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    for (const [repo, job] of this.jobs) {
      if (job.due !== Infinity) {
        this.jobs.delete(repo);
        job.resolve({ state: "error", error: "service stopping" });
      }
    }
    await Promise.all(this.running);
  }
}
