import { describe, expect, test } from "bun:test"
import { sourceChunks } from "./chunks"

const texts = (source: string) => sourceChunks(source).map((c) => c.text)

describe("sourceChunks", () => {
  test("splits runs of non-blank lines at blank lines", () => {
    expect(texts("# Title\nintro\n\n\n  \npara one\nstill one\n\nlast")).toEqual([
      "# Title\nintro",
      "para one\nstill one",
      "last",
    ])
  })

  test("ignores leading and trailing blank lines and CRLF endings", () => {
    expect(texts("\n\r\na\r\nb\r\n\r\nc\n\n")).toEqual(["a\nb", "c"])
  })

  test("keeps a fenced code block with blank lines in one chunk", () => {
    const source = "before\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nafter"
    expect(texts(source)).toEqual(["before\n```ts\nconst a = 1\n\nconst b = 2\n```", "after"])
  })

  test("matches tilde fences and longer closing fences", () => {
    expect(texts("~~~\na\n\n```\nb\n~~~~\n\nc")).toEqual(["~~~\na\n\n```\nb\n~~~~", "c"])
    expect(texts("````\na\n```\n\nb\n````\n\nc")).toEqual(["````\na\n```\n\nb\n````", "c"])
  })

  test("an unclosed fence runs to the end", () => {
    expect(texts("```\na\n\nb")).toEqual(["```\na\n\nb"])
  })

  test("inline backticks at a line start are not a fence", () => {
    expect(texts("```a``` is code\n\nnext")).toEqual(["```a``` is code", "next"])
  })

  test("dedents indented chunks that continue a list item", () => {
    const source = "1. Step\n\n   More about it.\n\n   ```sh\n   ls\n\n   pwd\n   ```\n\n2. Next"
    expect(sourceChunks(source)).toEqual([
      { text: "1. Step", indent: 0 },
      { text: "More about it.", indent: 3 },
      { text: "```sh\nls\n\npwd\n```", indent: 3 },
      { text: "2. Next", indent: 0 },
    ])
  })

  test("leaves indented chunks alone outside a list", () => {
    expect(sourceChunks("para\n\n    code")).toEqual([
      { text: "para", indent: 0 },
      { text: "    code", indent: 0 },
    ])
    expect(sourceChunks("- item\n\npara\n\n  indented")).toEqual([
      { text: "- item", indent: 0 },
      { text: "para", indent: 0 },
      { text: "  indented", indent: 0 },
    ])
  })
})
