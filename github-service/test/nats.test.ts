import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { serveNats } from "../src/nats.js";
import { GithubService } from "../src/service.js";
import { SnapshotStore } from "../src/store.js";
import {
  SUBJECTS,
  type ListResult,
  type RefreshOperation,
  type Reply,
} from "../src/protocol.js";
import { pr, repo } from "./fixtures.js";

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch {}
    await sleep(30);
  }
  throw new Error("condition timed out");
}
async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}
async function client(url: string): Promise<NatsConnection> {
  return eventually(
    () => connect({ servers: url, reconnect: false, timeout: 200 }),
    () => true,
  );
}

test(
  "NATS initial outage, API lifecycle, advisory events, reconnect and offline polling",
  { timeout: 25_000 },
  async () => {
    const port = await unusedPort();
    const url = `nats://127.0.0.1:${port}`;
    const store = new SnapshotStore(":memory:", [repo]);
    let version = 1;
    let now = 1000;
    const service = new GithubService(
      store,
      async () => ({
        viewer: "viewer",
        prs: [{ ...pr, title: `version ${version}` }],
      }),
      { now: () => now, cooldownMs: 10, pollMs: 100 },
    );
    const abort = new AbortController();
    const serving = serveNats(service, url, abort.signal);
    let server: ChildProcess | undefined;
    let nc: NatsConnection | undefined;
    try {
      service.tick();
      await eventually(
        async () => store.read(repo).snapshot.revision,
        (r) => r === 1,
      );
      server = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port)], {
        stdio: "ignore",
      });
      nc = await client(url);
      const request = async <T>(
        subject: string,
        input: unknown,
      ): Promise<Reply<T>> =>
        (
          await nc!.request(subject, JSON.stringify(input), { timeout: 300 })
        ).json();
      const initial = await eventually(
        () => request<ListResult>(SUBJECTS.list, {}),
        (r) => r.ok,
      );
      assert.equal(initial.ok && initial.data.prs[0].title, "version 1");
      const completed = nc.subscribe(SUBJECTS.completed);
      const changed = nc.subscribe(SUBJECTS.changed);
      const completionEvents: unknown[] = [];
      const changeEvents: unknown[] = [];
      const readingCompleted = (async () => {
        for await (const msg of completed) completionEvents.push(msg.json());
      })();
      const readingChanged = (async () => {
        for await (const msg of changed) changeEvents.push(msg.json());
      })();
      await nc.flush();
      now += 10;
      const refresh = await request<{ operationId: string }>(SUBJECTS.refresh, {
        repo,
      });
      assert.equal(refresh.ok, true);
      const operationId = refresh.ok ? refresh.data.operationId : "";
      const op = await eventually(
        () => request<RefreshOperation>(SUBJECTS.operation, { operationId }),
        (r) => r.ok && r.data.state === "complete",
      );
      assert.equal(op.ok && op.data.repositories[repo].changed, false);
      await eventually(
        async () => completionEvents.length,
        (n) => n === 1,
      );
      assert.equal(changeEvents.length, 0);
      version = 2;
      now += 100;
      service.tick();
      await eventually(
        async () => changeEvents.length,
        (n) => n === 1,
      );
      assert.equal((changeEvents[0] as { revision: number }).revision, 2);
      const malformed = (
        await nc.request(SUBJECTS.list, "{", { timeout: 300 })
      ).json<Reply<unknown>>();
      assert.equal(malformed.ok, false);
      await stop(server);
      await nc.closed();
      completed.unsubscribe();
      changed.unsubscribe();
      await Promise.all([readingCompleted, readingChanged]);
      version = 3;
      now += 100;
      service.tick();
      await eventually(
        async () => store.read(repo).snapshot.revision,
        (r) => r === 3,
      );
      server = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port)], {
        stdio: "ignore",
      });
      nc = await client(url);
      const after = await eventually(
        () => request<ListResult>(SUBJECTS.list, {}),
        (r) => r.ok && r.data.repositories[0].revision === 3,
      );
      assert.equal(after.ok && after.data.prs[0].title, "version 3");
      assert.equal(
        after.ok && initial.ok && after.data.storeId,
        initial.ok && initial.data.storeId,
      );
    } finally {
      abort.abort();
      await serving;
      await nc?.close();
      if (server) await stop(server);
      await service.close();
      store.close();
    }
  },
);
