import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  NewComment,
  Pr,
  PrFeedback,
  RepositorySnapshot,
} from "./protocol.js";

interface Row extends RepositorySnapshot {
  payload: string;
}

export interface FeedbackRecord {
  revision: number;
  fetchedAt: number | null;
  attemptedAt: number | null;
  sourceUpdatedAt: string | null;
  failures: number;
  error: string | null;
  feedback: PrFeedback | null;
}

interface FeedbackRow extends Omit<FeedbackRecord, "feedback"> {
  payload: string | null;
  seen: string;
}

function comments(feedback: PrFeedback): NewComment[] {
  return [
    ...feedback.threads.flatMap((thread) =>
      thread.comments
        .filter((c) => c.state !== "PENDING")
        .map(
          (c): NewComment => ({
            id: c.id,
            kind: "thread",
            author: c.author.login,
            createdAt: c.createdAt,
            threadId: thread.id,
          }),
        ),
    ),
    ...feedback.conversation.map(
      (e): NewComment => ({
        id: e.id,
        kind: e.kind,
        author: e.author.login,
        createdAt: e.createdAt,
      }),
    ),
  ];
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
      CREATE TABLE IF NOT EXISTS feedback (
        repo TEXT NOT NULL, number INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        fetchedAt INTEGER, attemptedAt INTEGER, sourceUpdatedAt TEXT,
        failures INTEGER NOT NULL DEFAULT 0, error TEXT,
        payload TEXT, seen TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (repo, number)
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
      this.db
        .prepare(
          "DELETE FROM feedback WHERE repo = ? AND number NOT IN (SELECT value FROM json_each(?))",
        )
        .run(repo, JSON.stringify(prs.map((pr) => pr.number)));
      this.db.exec("COMMIT");
      return { revision, changed };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tracked(repo: string, number: number): string | null {
    return (
      this.read(repo).prs.find((pr) => pr.number === number)?.updatedAt ?? null
    );
  }

  readFeedback(repo: string, number: number): FeedbackRecord {
    this.read(repo);
    const row = this.db
      .prepare("SELECT * FROM feedback WHERE repo = ? AND number = ?")
      .get(repo, number) as unknown as FeedbackRow | undefined;
    if (!row)
      return {
        revision: 0,
        fetchedAt: null,
        attemptedAt: null,
        sourceUpdatedAt: null,
        failures: 0,
        error: null,
        feedback: null,
      };
    return {
      revision: row.revision,
      fetchedAt: row.fetchedAt,
      attemptedAt: row.attemptedAt,
      sourceUpdatedAt: row.sourceUpdatedAt,
      failures: row.failures,
      error: row.error,
      feedback:
        row.payload === null ? null : (JSON.parse(row.payload) as PrFeedback),
    };
  }

  feedbackAttempted(repo: string, number: number, now: number): void {
    if (this.tracked(repo, number) === null) return;
    this.db
      .prepare(
        "INSERT INTO feedback(repo, number, attemptedAt) VALUES (?, ?, ?) ON CONFLICT(repo, number) DO UPDATE SET attemptedAt = excluded.attemptedAt",
      )
      .run(repo, number, now);
  }

  feedbackFailed(repo: string, number: number, now: number): void {
    if (this.tracked(repo, number) === null) return;
    this.db
      .prepare(
        "INSERT INTO feedback(repo, number, attemptedAt, failures, error) VALUES (?, ?, ?, 1, ?) ON CONFLICT(repo, number) DO UPDATE SET attemptedAt = excluded.attemptedAt, failures = failures + 1, error = excluded.error",
      )
      .run(repo, number, now, "GitHub collection failed");
  }

  replaceFeedback(
    repo: string,
    number: number,
    feedback: PrFeedback,
    sourceUpdatedAt: string,
    now: number,
  ): { revision: number; changed: boolean; newComments: NewComment[] } {
    if (feedback.repo !== repo || feedback.pr.number !== number)
      throw new Error("invalid feedback snapshot");
    const payload = JSON.stringify(feedback);
    const current = comments(feedback);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.tracked(repo, number) === null)
        throw new Error("pull request is not tracked");
      const old = this.db
        .prepare(
          "SELECT revision, fetchedAt, payload, seen FROM feedback WHERE repo = ? AND number = ?",
        )
        .get(repo, number) as unknown as FeedbackRow | undefined;
      const changed = (old?.payload ?? null) !== payload;
      const revision = (old?.revision ?? 0) + Number(changed);
      const seen = new Set(JSON.parse(old?.seen ?? "[]") as string[]);
      const newComments =
        old?.fetchedAt == null ? [] : current.filter((c) => !seen.has(c.id));
      this.db
        .prepare(
          "INSERT INTO feedback(repo, number, revision, fetchedAt, attemptedAt, sourceUpdatedAt, failures, error, payload, seen) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?) ON CONFLICT(repo, number) DO UPDATE SET revision = excluded.revision, fetchedAt = excluded.fetchedAt, attemptedAt = excluded.attemptedAt, sourceUpdatedAt = excluded.sourceUpdatedAt, failures = 0, error = NULL, payload = excluded.payload, seen = excluded.seen",
        )
        .run(
          repo,
          number,
          revision,
          now,
          now,
          sourceUpdatedAt,
          payload,
          JSON.stringify(current.map((c) => c.id)),
        );
      this.db.exec("COMMIT");
      return { revision, changed, newComments };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
