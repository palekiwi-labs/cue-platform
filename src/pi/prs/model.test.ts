import { describe, expect, test } from "bun:test"
import {
  applyPreset,
  buildRows,
  fmtAge,
  isContextAddress,
  parseSearch,
  type Pr,
  repoOfRemote,
  resolveScope,
  reviewContext,
  searchString,
  stackRepo,
  worktreeFor,
  branchLinks,
  prNote,
} from "./model"

const pr = (o: Partial<Pr>): Pr => ({
  repo: "o/r",
  number: 1,
  title: "t",
  url: "",
  author: "me",
  isDraft: false,
  createdAt: "2026-01-01T00:00:00Z",
  reviewDecision: null,
  checks: null,
  baseRef: "master",
  headRef: "h",
  defaultBranch: "master",
  reviewers: [],
  labels: [],
  ...o,
})

describe("parseSearch", () => {
  test("normalises nodes", () => {
    const json = JSON.stringify({
      data: {
        viewer: { login: "me" },
        search: {
          issueCount: 2,
          nodes: [
            {
              number: 5,
              title: "Fix",
              url: "u",
              isDraft: true,
              createdAt: "2026-01-02T00:00:00Z",
              reviewDecision: "APPROVED",
              baseRefName: "master",
              headRefName: "fix",
              author: { login: "bob" },
              repository: { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } },
              reviewRequests: { nodes: [{ requestedReviewer: { login: "me" } }, { requestedReviewer: {} }] },
              commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
            },
            {},
          ],
        },
      },
    })
    const r = parseSearch(json)
    expect(r.viewer).toBe("me")
    expect(r.total).toBe(2)
    expect(r.prs).toHaveLength(1)
    expect(r.prs[0]).toMatchObject({
      repo: "o/r",
      number: 5,
      author: "bob",
      isDraft: true,
      checks: "FAILURE",
      defaultBranch: "main",
      reviewers: ["me"],
    })
  })

  test("missing checks and author", () => {
    const r = parseSearch(JSON.stringify({ data: { search: { nodes: [{ number: 1, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }] } } }))
    expect(r.prs[0]!.checks).toBeNull()
    expect(r.prs[0]!.author).toBe("ghost")
  })
})

test("searchString", () => {
  expect(searchString("repo", "o/r")).toBe("is:pr is:open archived:false repo:o/r")
  expect(searchString("org", "o")).toBe("is:pr is:open archived:false org:o")
})

test("repoOfRemote", () => {
  expect(repoOfRemote("git@github.com:palekiwi/palekiwi.git")).toBe("palekiwi/palekiwi")
  expect(repoOfRemote("https://github.com/palekiwi-labs/cue-platform")).toBe("palekiwi-labs/cue-platform")
  expect(repoOfRemote("https://github.com/a/b.git\n")).toBe("a/b")
  expect(repoOfRemote("https://gitlab.com/a/b")).toBeUndefined()
})

describe("resolveScope", () => {
  test("cue.gh-org wins and selects org view", () => {
    expect(resolveScope(["spabreaks", "spabreaks"], "palekiwi/spabreaks-org")).toEqual({ orgs: ["spabreaks"], view: "org" })
  })
  test("falls back to origin owner in repo view", () => {
    expect(resolveScope([], "palekiwi-labs/cue")).toEqual({ orgs: ["palekiwi-labs"], view: "repo" })
    expect(resolveScope([], undefined)).toEqual({ orgs: [], view: "repo" })
  })
})

test("applyPreset", () => {
  const prs = [pr({ number: 1, author: "me" }), pr({ number: 2, author: "x", reviewers: ["me"] }), pr({ number: 3, author: "x" })]
  expect(applyPreset(prs, "all", "me").map((p) => p.number)).toEqual([1, 2, 3])
  expect(applyPreset(prs, "mine", "me").map((p) => p.number)).toEqual([1])
  expect(applyPreset(prs, "review", "me").map((p) => p.number)).toEqual([2])
})

describe("stackRepo", () => {
  test("nests PRs on their parent's head, roots newest first", () => {
    const a = pr({ number: 1, headRef: "a", createdAt: "2026-01-01T00:00:00Z" })
    const b = pr({ number: 2, baseRef: "a", headRef: "b" })
    const c = pr({ number: 3, baseRef: "b", headRef: "c" })
    const d = pr({ number: 4, headRef: "d", createdAt: "2026-02-01T00:00:00Z" })
    const e = pr({ number: 5, baseRef: "gone", headRef: "e", createdAt: "2025-01-01T00:00:00Z" })
    expect(stackRepo([c, b, a, d, e]).map((x) => [x.pr.number, x.depth])).toEqual([
      [4, 0],
      [1, 0],
      [2, 1],
      [3, 2],
      [5, 0],
    ])
  })
  test("cycles still list every PR once", () => {
    const a = pr({ number: 1, baseRef: "b", headRef: "a" })
    const b = pr({ number: 2, baseRef: "a", headRef: "b" })
    expect(stackRepo([a, b]).map((x) => x.pr.number).sort()).toEqual([1, 2])
  })
})

test("buildRows groups org view by repo and folds", () => {
  const prs = [
    pr({ repo: "o/old", number: 1, createdAt: "2025-01-01T00:00:00Z" }),
    pr({ repo: "o/new", number: 2, createdAt: "2026-01-01T00:00:00Z" }),
  ]
  expect(buildRows(prs, "repo", new Set()).map((r) => r.kind)).toEqual(["pr", "pr"])
  const rows = buildRows(prs, "org", new Set(["o/old"]))
  expect(rows).toEqual([
    { kind: "repo", repo: "o/new", count: 1, folded: false },
    { kind: "pr", pr: prs[1]!, depth: 0 },
    { kind: "repo", repo: "o/old", count: 1, folded: true },
  ])
})

test("fmtAge", () => {
  const now = Date.parse("2026-03-01T00:00:00Z")
  expect(fmtAge("2026-02-28T23:59:30Z", now)).toBe("30s")
  expect(fmtAge("2026-02-28T19:00:00Z", now)).toBe("5h")
  expect(fmtAge("2026-02-26T00:00:00Z", now)).toBe("3d")
  expect(fmtAge("2026-01-25T00:00:00Z", now)).toBe("5w")
  expect(fmtAge("2025-10-01T00:00:00Z", now)).toBe("5mo")
  expect(fmtAge("2024-01-01T00:00:00Z", now)).toBe("2y")
  expect(fmtAge("nope", now)).toBe("?")
})

test("reviewContext matches cue-review slugify", () => {
  expect(reviewContext(pr({ headRef: "Feat/Cue_Agent!" }))).toBe("review-feat-cue_agent")
})

test("worktreeFor", () => {
  const out = "worktree /r\nHEAD x\nbranch refs/heads/master\n\nworktree /r/worktrees/dev\nHEAD y\nbranch refs/heads/dev\n"
  expect(worktreeFor(out, "dev")).toBe("/r/worktrees/dev")
  expect(worktreeFor(out, "master")).toBe("/r")
  expect(worktreeFor(out, "devx")).toBeUndefined()
})

test("isContextAddress", () => {
  expect(isContextAddress("palekiwi/palekiwi/pi-gh-prs")).toBe(true)
  expect(isContextAddress("pi-gh-prs")).toBe(false)
  expect(isContextAddress("a/b/c/d")).toBe(false)
})


test("branchLinks keeps dotted branch names", () => {
  const out = "branch.master.cue-context shared\nbranch.feat/v1.2.cue-context feat-v1.2\n"
  expect([...branchLinks(out)]).toEqual([["master", "shared"], ["feat/v1.2", "feat-v1.2"]])
})

test("prNote", () => {
  const p = pr({ number: 9, headRef: "feat", baseRef: "master" })
  expect(prNote(p, "/r/worktrees/feat")).toContain("checkout: /r/worktrees/feat")
})
