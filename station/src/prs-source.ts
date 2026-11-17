import { GithubClient, snapshotHealth, snapshotKey } from "../../github-service/src/client.js";
import type { PrSummary } from "./source.js";

export class PrsSource {
  readonly client = new GithubClient();

  constructor(readonly repo: string) {}

  async load(refresh = false): Promise<{ prs: PrSummary[]; viewer: string; revision: string; note: string; healthy: boolean }> {
    if (refresh) await this.client.refresh(this.repo);
    const data = await this.client.list(this.repo);
    const health = snapshotHealth(data);
    const fetchedAt = data.repositories[0]?.fetchedAt;
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
      viewer: data.repositories[0]?.viewer ?? "",
      revision: snapshotKey(data),
      note: health.length ? health.join("; ") : fetchedAt ? `fetched ${new Date(fetchedAt).toLocaleTimeString()}` : "not fetched yet",
      healthy: health.length === 0,
    };
  }
}
