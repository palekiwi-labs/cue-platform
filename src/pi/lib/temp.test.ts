import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { withTempFile } from "./temp"

describe("withTempFile", () => {
  test("concurrent calls each read back their own content", async () => {
    const contents = Array.from({ length: 20 }, (_, i) => `body-${i}`)
    const read = await Promise.all(
      contents.map((c) => withTempFile(c, "t", "md", (p) => readFile(p, "utf8"))),
    )
    expect(read).toEqual(contents)
  })
})
