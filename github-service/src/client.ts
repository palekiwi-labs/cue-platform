import { connect, type NatsConnection } from "@nats-io/transport-node";
import { setTimeout as sleep } from "node:timers/promises";
import {
  SUBJECTS,
  type ListRequest,
  type ListResult,
  type RefreshOperation,
  type RefreshResult,
  type Reply,
} from "./protocol.js";

export class GithubClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class GithubClient {
  private connection?: Promise<NatsConnection>;
  private listeners = new Set<() => void>();
  private closed = false;
  private abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private url = process.env.CUE_NATS_URL || "nats://127.0.0.1:4222",
  ) {}

  private hint(): void {
    if (this.closed) return;
    for (const listener of this.listeners) listener();
  }

  watch(listener: () => void): () => void {
    this.listeners.add(listener);
    if (!this.timer) {
      this.timer = setInterval(() => this.hint(), 30_000);
      this.timer.unref();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  private async connected(): Promise<NatsConnection> {
    if (this.closed)
      throw new GithubClientError("closed", "GitHub client is closed");
    if (!this.connection) {
      const pending = connect({
        servers: this.url,
        timeout: 2000,
        reconnect: true,
        maxReconnectAttempts: -1,
      });
      this.connection = pending;
      try {
        const nc = await pending;
        if (this.closed) {
          await nc.close();
          throw new GithubClientError("closed", "GitHub client is closed");
        }
        for (const subject of [SUBJECTS.changed, SUBJECTS.completed]) {
          const subscription = nc.subscribe(subject);
          void (async () => {
            for await (const _message of subscription) this.hint();
          })().catch(() => this.hint());
        }
        void (async () => {
          for await (const status of nc.status()) {
            if (status.type === "reconnect" || status.type === "disconnect")
              this.hint();
          }
        })().catch(() => this.hint());
        void nc.closed().then(() => {
          if (this.connection === pending) this.connection = undefined;
          this.hint();
        });
        await nc.flush();
        return nc;
      } catch {
        if (this.connection === pending) this.connection = undefined;
        throw new GithubClientError(
          "unavailable",
          "GitHub service connection unavailable",
        );
      }
    }
    return this.connection;
  }

  private async request<T>(subject: string, body: unknown): Promise<T> {
    const nc = await this.connected();
    let reply: Reply<T>;
    try {
      reply = (
        await nc.request(subject, JSON.stringify(body), { timeout: 3000 })
      ).json<Reply<T>>();
    } catch {
      throw new GithubClientError(
        "unavailable",
        "GitHub service did not respond",
      );
    }
    if (!reply.ok)
      throw new GithubClientError(reply.error.code, reply.error.message);
    return reply.data;
  }

  async list(repo?: string): Promise<ListResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const first = await this.request<ListResult>(SUBJECTS.list, {
          repo,
          limit: 50,
        });
        const prs = [...first.prs];
        const offsets = new Set<number>();
        let offset = first.nextOffset;
        const guard: ListRequest = {
          repo,
          limit: 50,
          storeId: first.storeId,
          revisions: Object.fromEntries(
            first.repositories.map((r) => [r.repo, r.revision]),
          ),
        };
        while (offset !== null) {
          if (offsets.has(offset))
            throw new GithubClientError(
              "invalid_response",
              "Repeated snapshot page",
            );
          offsets.add(offset);
          const page = await this.request<ListResult>(SUBJECTS.list, {
            ...guard,
            offset,
          });
          prs.push(...page.prs);
          offset = page.nextOffset;
        }
        return { ...first, prs, nextOffset: null };
      } catch (error) {
        if (
          !(error instanceof GithubClientError) ||
          error.code !== "conflict" ||
          attempt === 2
        )
          throw error;
      }
    }
    throw new GithubClientError(
      "conflict",
      "Snapshot changed during pagination",
    );
  }

  async refresh(repo?: string): Promise<RefreshOperation> {
    const { operationId } = await this.request<RefreshResult>(
      SUBJECTS.refresh,
      { repo },
    );
    while (!this.closed) {
      const operation = await this.request<RefreshOperation>(
        SUBJECTS.operation,
        { operationId },
      );
      if (operation.state === "complete") return operation;
      await sleep(500, undefined, { signal: this.abort.signal });
    }
    throw new GithubClientError("closed", "GitHub client is closed");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    this.listeners.clear();
    try {
      await (await this.connection)?.close();
    } catch {}
  }
}

export function snapshotKey(snapshot: ListResult): string {
  return JSON.stringify([
    snapshot.storeId,
    snapshot.repositories.map((r) => [r.repo, r.revision]),
  ]);
}

export function snapshotHealth(snapshot: ListResult): string[] {
  return snapshot.repositories.flatMap((r) =>
    r.error
      ? [`${r.repo}: ${r.error}`]
      : r.fetchedAt === null
        ? [`${r.repo}: not fetched yet`]
        : [],
  );
}
