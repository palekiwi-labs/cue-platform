import { GithubClient, snapshotHealth, snapshotKey } from "../../../github-service/src/client.js"
import type { ListResult } from "../../../github-service/src/protocol.js"
import type { Loaded } from "./browser"
import type { View } from "./model"

export class PrSource {
  readonly client = new GithubClient()

  constructor(private localRepo: string | undefined, private orgs: string[]) {}

  private async snapshot(view: View): Promise<ListResult> {
    if (view === "repo" && !this.localRepo) throw new Error("no GitHub repository")
    const data = await this.client.list(view === "repo" ? this.localRepo?.toLowerCase() : undefined)
    if (view === "repo") return data
    const orgs = new Set(this.orgs.map((org) => org.toLowerCase()))
    const repositories = data.repositories.filter((r) => orgs.has(r.repo.split("/")[0]!))
    if (repositories.length === 0) throw new Error("no configured repositories for these orgs in GitHub service")
    const repos = new Set(repositories.map((r) => r.repo))
    return { ...data, repositories, prs: data.prs.filter((p) => repos.has(p.repo)) }
  }

  async load(view: View, refresh = false): Promise<Loaded | { error: string }> {
    try {
      if (refresh) {
        const before = await this.snapshot(view)
        await Promise.all(before.repositories.map((r) => this.client.refresh(r.repo)))
      }
      const data = await this.snapshot(view)
      const fetched = data.repositories.flatMap((r) => r.fetchedAt === null ? [] : [r.fetchedAt])
      return {
        prs: data.prs,
        viewer: data.repositories[0]?.viewer ?? "",
        viewers: Object.fromEntries(data.repositories.map((r) => [r.repo, r.viewer ?? ""])),
        truncated: false,
        failed: snapshotHealth(data),
        revision: snapshotKey(data),
        fetchedAt: fetched.length ? Math.min(...fetched) : undefined,
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : "GitHub service unavailable" }
    }
  }
}
