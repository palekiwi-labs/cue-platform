import { describe, expect, test } from "bun:test"
import { copyText, sourceChunks } from "./chunks"

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

describe("copyText", () => {
  test("strips the fences of a chunk that is one fenced code block", () => {
    expect(copyText("```\nbun run context --latest /home/pl/code/palekiwi/palekiwi\n```")).toBe(
      "bun run context --latest /home/pl/code/palekiwi/palekiwi",
    )
  })

  test("strips a language annotation or info string", () => {
    expect(copyText("```sh\nls -la\n```")).toBe("ls -la")
    expect(copyText("``` bash title=x\npwd\n```")).toBe("pwd")
    expect(copyText("~~~nu\nls\n~~~")).toBe("ls")
  })

  test("keeps inner lines, blank lines and indentation", () => {
    const source = "```sh\nif true; then\n  echo a\n\n  echo b\nfi\n```"
    expect(copyText(source)).toBe("if true; then\n  echo a\n\n  echo b\nfi")
  })

  test("accepts longer closing fences and nested shorter fences", () => {
    expect(copyText("```\na\n`````")).toBe("a")
    expect(copyText("````md\n```\nx\n```\n````")).toBe("```\nx\n```")
  })

  test("removes the fence indent from inner lines", () => {
    expect(copyText("  ```\n  ls\n    pwd\n  ```")).toBe("ls\n  pwd")
  })

  test("leaves mixed prose and code unchanged", () => {
    for (const source of ["Run this:\n```sh\nls\n```", "```sh\nls\n```\nthen check.", "```\na\n```\n```\nb\n```"]) {
      expect(copyText(source)).toBe(source)
    }
  })

  test("leaves unclosed, mismatched or empty fences unchanged", () => {
    for (const source of ["```sh\nls\n\npwd", "```\nls\n~~~", "````\nls\n```", "```\nls\n``` x", "```\n```"]) {
      expect(copyText(source)).toBe(source)
    }
  })

  test("strips the backticks of a chunk that is one inline code span", () => {
    expect(copyText("`git status --short`")).toBe("git status --short")
    expect(copyText("`` echo `date` ``")).toBe("echo `date`")
    expect(copyText("``echo `date` ``")).toBe("echo `date` ")
    expect(copyText("`` `x` ``")).toBe("`x`")
  })

  test("leaves inline code mixed with prose or other spans unchanged", () => {
    for (const source of ["Run `ls` now", "`ls` and `pwd`", "`ls`.", "`unclosed", "``", "` `", "`a`\n`b`", "**bold** `code`"]) {
      expect(copyText(source)).toBe(source)
    }
  })
})
