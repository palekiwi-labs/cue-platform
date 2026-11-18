import { randomUUID } from "node:crypto";
import { RateLimitError } from "./collector.js";
import type {
  ChangedEvent,
  CompletedEvent,
  FeedbackEvent,
  Pr,
  PrFeedback,
  RefreshOperation,
  RefreshOutcome,
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
type Outcome = RefreshOutcome;
interface Job {
  repo: string;
  number?: number;
  due: number;
  promise: Promise<Outcome>;
  resolve: (value: Outcome) => void;
}
export interface ServiceOptions {
  pollMs?: number;
  concurrency?: number;
  feedbackConcurrency?: number;
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
  feedbackChanged: FeedbackEvent;
}
type ServiceEvent = ServiceEvents[keyof ServiceEvents];
export type FetchRepository = (
  repo: string,
  signal: AbortSignal,
) => Promise<{ viewer: string; prs: Pr[] }>;
export type FetchFeedback = (
  repo: string,
  number: number,
  signal: AbortSignal,
) => Promise<PrFeedback>;

class NotTracked extends Error {}

export class GithubService {
  readonly options: Required<ServiceOptions>;
  private jobs = new Map<string, Job>();
  private feedbackJobs = new Map<string, Job>();
  private running = new Set<Promise<void>>();
  private runningRepos = 0;
  private runningFeedback = 0;
  private pausedUntil = 0;
  private nextPoll = new Map<string, number>();
  private operations = new Map<string, RefreshOperation>();
  private listeners = new Set<
    (subject: keyof ServiceEvents, event: ServiceEvent) => void
  >();
  private abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    readonly store: SnapshotStore,
    private fetch: FetchRepository,
    options: ServiceOptions = {},
    private fetchFeedback?: FetchFeedback,
  ) {
    this.options = {
      pollMs: 120_000,
      concurrency: 2,
      feedbackConcurrency: 1,
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
  private allowedAt(repo: string, number?: number): number {
    const s =
      number === undefined
        ? this.store.read(repo).snapshot
        : this.store.readFeedback(repo, number);
    return s.attemptedAt === null ? 0 : s.attemptedAt + this.delay(s.failures);
  }
  pause(until: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, until);
  }
  paused(): number | null {
    return this.pausedUntil > this.options.now() ? this.pausedUntil : null;
  }
  onEvent(
    listener: (subject: keyof ServiceEvents, event: ServiceEvent) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit<K extends keyof ServiceEvents>(
    subject: K,
    event: ServiceEvents[K],
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
  tracked(repo: string, number: number): string {
    this.select(repo);
    const updatedAt = this.store.tracked(repo, number);
    if (updatedAt === null)
      throw new ServiceError("not_found", "pull request is not tracked");
    return updatedAt;
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
  refresh(repo?: string, number?: number): { operationId: string } {
    if (this.abort.signal.aborted)
      throw new ServiceError("unavailable", "service is stopping");
    if (number !== undefined) {
      if (repo === undefined)
        throw new ServiceError("invalid_request", "number requires repo");
      if (!this.fetchFeedback)
        throw new ServiceError("unavailable", "feedback is not collected");
      this.tracked(repo, number);
    }
    const repos = number === undefined ? this.select(repo) : [];
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
      pausedUntil: null,
      repositories: Object.fromEntries(
        repos.map((r) => [r, { state: "pending" }]),
      ),
    };
    const pending = repos.map(async (r) => {
      op.repositories[r] = await this.enqueue(r);
    });
    if (repo !== undefined && number !== undefined) {
      op.feedback = { repo, number, state: "pending" };
      pending.push(
        this.enqueueFeedback(repo, number).then((outcome) => {
          op.feedback = { repo, number, ...outcome };
        }),
      );
    }
    this.operations.set(operationId, op);
    void Promise.all(pending).then(() => {
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
    return { ...structuredClone(op), pausedUntil: this.paused() };
  }
  private enqueue(repo: string): Promise<Outcome> {
    return this.queue(this.jobs, repo, repo);
  }
  private enqueueFeedback(repo: string, number: number): Promise<Outcome> {
    return this.queue(this.feedbackJobs, `${repo}#${number}`, repo, number);
  }
  private queue(
    jobs: Map<string, Job>,
    key: string,
    repo: string,
    number?: number,
  ): Promise<Outcome> {
    const existing = jobs.get(key);
    if (existing) return existing.promise;
    let resolve!: (value: Outcome) => void;
    const promise = new Promise<Outcome>((r) => {
      resolve = r;
    });
    jobs.set(key, {
      repo,
      number,
      due: this.allowedAt(repo, number),
      promise,
      resolve,
    });
    return promise;
  }
  private scheduleFeedback(repo: string): void {
    if (!this.fetchFeedback) return;
    for (const pr of this.store.read(repo).prs) {
      if (
        this.store.readFeedback(repo, pr.number).sourceUpdatedAt !==
        pr.updatedAt
      )
        void this.enqueueFeedback(repo, pr.number);
    }
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
  private launch(work: () => Promise<void>, done: () => void): void {
    const task = work().finally(() => {
      done();
      this.running.delete(task);
      this.pump();
    });
    this.running.add(task);
  }
  private pump(): void {
    if (this.abort.signal.aborted) return;
    const now = this.options.now();
    if (this.pausedUntil > now) return;
    for (const job of this.jobs.values()) {
      if (this.runningRepos >= this.options.concurrency) break;
      if (job.due > now) continue;
      job.due = Infinity;
      this.runningRepos++;
      this.launch(
        () => this.run(job),
        () => this.runningRepos--,
      );
    }
    if ([...this.jobs.values()].some((job) => job.due <= now)) return;
    for (const job of this.feedbackJobs.values()) {
      if (this.runningFeedback >= this.options.feedbackConcurrency) break;
      if (job.due > now) continue;
      job.due = Infinity;
      this.runningFeedback++;
      this.launch(
        () => this.runFeedback(job),
        () => this.runningFeedback--,
      );
    }
  }
  private limited(job: Job, error: unknown): boolean {
    if (!(error instanceof RateLimitError) || this.abort.signal.aborted)
      return false;
    this.pause(error.until);
    job.due = error.until;
    return true;
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
      this.scheduleFeedback(job.repo);
    } catch (error) {
      if (this.limited(job, error)) return;
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
  private async runFeedback(job: Job): Promise<void> {
    const { repo } = job;
    const number = job.number!;
    let outcome: Outcome;
    try {
      const source = this.store.tracked(repo, number);
      if (source === null) throw new NotTracked();
      this.store.feedbackAttempted(repo, number, this.options.now());
      const feedback = await this.fetchFeedback!(
        repo,
        number,
        this.abort.signal,
      );
      if (this.abort.signal.aborted) throw new Error("stopping");
      if (this.store.tracked(repo, number) === null) throw new NotTracked();
      const { newComments, ...saved } = this.store.replaceFeedback(
        repo,
        number,
        feedback,
        source,
        this.options.now(),
      );
      outcome = { state: "success", ...saved };
      if (saved.changed)
        this.emit("feedbackChanged", {
          storeId: this.store.storeId,
          repo,
          number,
          revision: saved.revision,
          newComments,
        });
    } catch (error) {
      if (this.limited(job, error)) return;
      if (error instanceof NotTracked) {
        outcome = { state: "error", error: "pull request is not tracked" };
      } else {
        try {
          this.store.feedbackFailed(repo, number, this.options.now());
        } catch {}
        outcome = { state: "error", error: "GitHub collection failed" };
      }
    }
    this.feedbackJobs.delete(`${repo}#${number}`);
    job.resolve(outcome);
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    for (const jobs of [this.jobs, this.feedbackJobs]) {
      for (const [key, job] of jobs) {
        if (job.due !== Infinity) {
          jobs.delete(key);
          job.resolve({ state: "error", error: "service stopping" });
        }
      }
    }
    await Promise.all(this.running);
  }
}
