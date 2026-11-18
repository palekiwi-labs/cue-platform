import { GithubClient, snapshotHealth } from "../../github-service/src/client.js";
import type { RefreshOutcome } from "../../github-service/src/protocol.js";
import type { PrSummary } from "./source.js";

export interface PrsData {
  prs: PrSummary[];
  viewer: string;
  storeId: string;
  revision: number;
  note: string;
  healthy: boolean;
}

export class PrsSource {
  readonly client = new GithubClient();

  constructor(readonly repo: string) {}

  async load(refresh = false): Promise<PrsData> {
    if (refresh) await this.refresh();
    return this.read();
  }

  async refresh(): Promise<RefreshOutcome | undefined> {
    return (await this.client.refresh(this.repo)).repositories[this.repo];
  }

  async read(): Promise<PrsData> {
    const data = await this.client.list(this.repo);
    const health = snapshotHealth(data);
    const repository = data.repositories.find((r) => r.repo === this.repo) ?? data.repositories[0];
    const fetchedAt = repository?.fetchedAt;
    return {
      prs: data.prs.map((p) => ({
        number: p.number,
        title: p.title,
        url: p.url,
        author: p.author,
        baseRef: p.baseRef,
        headRef: p.headRef,
        defaultBranch: p.defaultBranch,
        isDraft: p.isDraft,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        reviewDecision: p.reviewDecision ?? "",
        requested: p.reviewers,
      })),
      viewer: repository?.viewer ?? "",
      storeId: data.storeId,
      revision: repository?.revision ?? 0,
      note: health.length ? health.join("; ") : fetchedAt ? `fetched ${new Date(fetchedAt).toLocaleTimeString()}` : "not fetched yet",
      healthy: health.length === 0,
    };
  }
}
