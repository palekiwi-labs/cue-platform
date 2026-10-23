import { describe, expect, test } from "bun:test"
import { frontmatterFlags } from "./frontmatter"

describe("frontmatterFlags", () => {
  test("scalar emits one pair", () => {
    expect(frontmatterFlags({ status: "open" })).toEqual([
      "--frontmatter",
      "status=open",
    ])
  })

  test("array emits one pair per element", () => {
    expect(frontmatterFlags({ refs: ["a", "b"] })).toEqual([
      "--frontmatter",
      "refs=a",
      "--frontmatter",
      "refs=b",
    ])
  })

  test("empty array emits nothing", () => {
    expect(frontmatterFlags({ refs: [] })).toEqual([])
  })

  test("null and undefined values are skipped", () => {
    expect(frontmatterFlags({ a: undefined, b: null, c: "x" })).toEqual([
      "--frontmatter",
      "c=x",
    ])
  })

  test("mixed scalars and arrays interleave in key order", () => {
    expect(frontmatterFlags({ status: "open", refs: ["r1"], parent: "p" })).toEqual([
      "--frontmatter",
      "status=open",
      "--frontmatter",
      "refs=r1",
      "--frontmatter",
      "parent=p",
    ])
  })
})
