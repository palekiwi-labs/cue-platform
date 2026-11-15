import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Pr, RepositorySnapshot } from "./protocol.js";

interface Row extends RepositorySnapshot {
  payload: string;
}

export class SnapshotStore {
  private db: DatabaseSync;
  readonly storeId: string;

  constructor(
    path: string,
    readonly repos: readonly string[],
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS identity (id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (
        repo TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
        viewer TEXT, fetchedAt INTEGER, attemptedAt INTEGER,
        failures INTEGER NOT NULL DEFAULT 0, error TEXT,
        payload TEXT NOT NULL DEFAULT '[]'
      );
    `);
    if (!this.db.prepare("SELECT id FROM identity").get()) {
      this.db.prepare("INSERT INTO identity VALUES (?)").run(randomUUID());
    }
    this.storeId = (
      this.db.prepare("SELECT id FROM identity").get() as { id: string }
    ).id;
    for (const repo of repos)
      this.db
        .prepare("INSERT OR IGNORE INTO snapshots(repo) VALUES (?)")
        .run(repo);
  }

  read(repo: string): { snapshot: RepositorySnapshot; prs: Pr[] } {
    if (!this.repos.includes(repo)) throw new Error("unconfigured repository");
    const { payload, ...snapshot } = this.db
      .prepare("SELECT * FROM snapshots WHERE repo = ?")
      .get(repo) as unknown as Row;
    return { snapshot, prs: JSON.parse(payload) as Pr[] };
  }

  attempted(repo: string, now: number): void {
    this.read(repo);
    this.db
      .prepare("UPDATE snapshots SET attemptedAt = ? WHERE repo = ?")
      .run(now, repo);
  }

  failed(repo: string, now: number): void {
    this.read(repo);
    this.db
      .prepare(
        "UPDATE snapshots SET attemptedAt = ?, failures = failures + 1, error = ? WHERE repo = ?",
      )
      .run(now, "GitHub collection failed", repo);
  }

  replace(
    repo: string,
    viewer: string,
    prs: Pr[],
    now: number,
  ): { revision: number; changed: boolean } {
    if (
      !viewer ||
      prs.some((pr) => pr.repo !== repo) ||
      new Set(prs.map((pr) => pr.number)).size !== prs.length
    ) {
      throw new Error("invalid repository snapshot");
    }
    const payload = JSON.stringify(
      [...prs]
        .sort((a, b) => a.number - b.number)
        .map((pr) => ({
          repo: pr.repo,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          author: pr.author,
          isDraft: pr.isDraft,
          createdAt: pr.createdAt,
          updatedAt: pr.updatedAt,
          reviewDecision: pr.reviewDecision,
          checks: pr.checks,
          baseRef: pr.baseRef,
          headRef: pr.headRef,
          defaultBranch: pr.defaultBranch,
          reviewers: [...new Set(pr.reviewers)].sort(),
          labels: [...new Set(pr.labels)].sort(),
        })),
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.read(repo);
      const changed =
        old.snapshot.viewer !== viewer || JSON.stringify(old.prs) !== payload;
      const revision = old.snapshot.revision + Number(changed);
      this.db
        .prepare(
          "UPDATE snapshots SET revision = ?, viewer = ?, fetchedAt = ?, attemptedAt = ?, failures = 0, error = NULL, payload = ? WHERE repo = ?",
        )
        .run(revision, viewer, now, now, payload, repo);
      this.db.exec("COMMIT");
      return { revision, changed };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
