import { expect, test } from "bun:test"
import { PrSource } from "./source"
import type { ListResult } from "../../../github-service/src/protocol.js"

const snapshot = (): ListResult => ({
  storeId: "store", total: 0, nextOffset: null, prs: [],
  repositories: ["spabreaks/one", "spabreaks/two", "other/repo"].map((repo, index) => ({
    repo, revision: 1, viewer: `viewer-${index}`, fetchedAt: 1000, attemptedAt: 1000, failures: 0, error: null,
  })),
})

test("org source uses configured repositories and per-repository viewer identities", async () => {
  const source = new PrSource("spabreaks/one", ["spabreaks"])
  const calls: (string | undefined)[] = []
  source.client.list = async (repo) => { calls.push(repo); return snapshot() }
  const data = await source.load("org")
  expect(calls).toEqual([undefined])
  expect("error" in data).toBe(false)
  if (!("error" in data)) {
    expect(data.viewers).toEqual({ "spabreaks/one": "viewer-0", "spabreaks/two": "viewer-1" })
    expect(data.failed).toEqual([])
  }
  await source.client.close()
})

test("refresh targets only repositories in the selected org and reads snapshots afterward", async () => {
  const source = new PrSource("spabreaks/one", ["spabreaks"])
  const calls: string[] = []
  source.client.list = async () => { calls.push("list"); return snapshot() }
  source.client.refresh = async (repo) => {
    calls.push(`refresh:${repo}`)
    return { operationId: "op", createdAt: 0, completedAt: 1, state: "complete", repositories: {} }
  }
  await source.load("org", true)
  expect(calls).toEqual(["list", "refresh:spabreaks/one", "refresh:spabreaks/two", "list"])
  await source.client.close()
})

test("unfetched repositories and unavailable service remain distinct from a successful empty list", async () => {
  const source = new PrSource("spabreaks/one", ["spabreaks"])
  source.client.list = async () => {
    const data = snapshot()
    data.repositories[0]!.fetchedAt = null
    return data
  }
  const data = await source.load("org")
  expect("error" in data ? [] : data.failed).toEqual(["spabreaks/one: not fetched yet"])
  source.client.list = async () => { throw new Error("service unavailable") }
  expect(await source.load("org")).toEqual({ error: "service unavailable" })
  await source.client.close()
})
