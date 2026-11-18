#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { collect, createGhGraphql } from "./collector.js";
import { parseConfig } from "./config.js";
import { collectFeedback } from "./feedback.js";
import { serveNats } from "./nats.js";
import { GithubService } from "./service.js";
import { SnapshotStore } from "./store.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: cue-github [--config PATH]\nRead-only config: ~/.config/cue/github.toml\nPrivate state: ~/.local/state/cue/github/snapshots.sqlite",
    );
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== "--config"))
    throw new Error("invalid arguments");
  const configPath =
    args[1] ??
    join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "cue/github.toml",
    );
  const config = parseConfig(readFileSync(configPath, "utf8"));
  const statePath = join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
    "cue/github/snapshots.sqlite",
  );
  process.umask(0o077);
  const store = new SnapshotStore(statePath, config.repositories);
  const graphql = createGhGraphql((until) => service.pause(until));
  const service: GithubService = new GithubService(
    store,
    (repo, signal) => collect(repo, graphql, signal),
    config.scheduling,
    (repo, number, signal) => collectFeedback(repo, number, graphql, signal),
  );
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    service.start();
    await serveNats(
      service,
      process.env.CUE_NATS_URL?.trim() || config.natsUrl,
      abort.signal,
    );
  } finally {
    await service.close();
    store.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch(() => {
  console.error(
    "cue-github failed: check arguments, read-only configuration and private state directory",
  );
  process.exitCode = 1;
});
