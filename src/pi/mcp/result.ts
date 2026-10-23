import { randomUUID } from "node:crypto"
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type TruncationOptions,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CAST_SERVER } from "./naming"

type TextContent = { type: "text"; text: string }
type ImageContent = { type: "image"; data: string; mimeType: string }
type Content = TextContent | ImageContent

export interface McpResultDetails {
  server: string
  tool: string
  result: Record<string, unknown>
  truncation?: TruncationResult
  fullOutputPath?: string
}

export interface MappedResult {
  content: Content[]
  details: McpResultDetails
}

export interface MapOptions {
  truncation?: TruncationOptions
  /** Writes the untruncated text and returns its path. */
  saveFullOutput?: (tool: string, text: string) => Promise<string>
}

type Block = Record<string, any>

function describeResource(resource: Block): string {
  const uri = String(resource.uri ?? "")
  if (typeof resource.text === "string") return `[resource ${uri}]\n${resource.text}`
  const mime = resource.mimeType ? `, ${resource.mimeType}` : ""
  return `[binary resource ${uri}${mime}]`
}

function mapBlock(block: Block): Content {
  switch (block.type) {
    case "text":
      return { type: "text", text: String(block.text ?? "") }
    case "image":
      return { type: "image", data: String(block.data ?? ""), mimeType: String(block.mimeType ?? "") }
    case "audio":
      return { type: "text", text: `[audio ${block.mimeType ?? "unknown type"}]` }
    case "resource":
      return { type: "text", text: describeResource(block.resource ?? {}) }
    case "resource_link": {
      const name = block.name ? `${block.name} ` : ""
      return { type: "text", text: `[resource link ${name}${block.uri ?? ""}]` }
    }
    default:
      return { type: "text", text: `[unsupported MCP content ${String(block.type)}]` }
  }
}

function textOf(content: Content[]): string {
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n")
}

export async function saveFullOutputToTemp(tool: string, text: string): Promise<string> {
  const path = join(tmpdir(), `pi-mcp-cast-${tool}-${randomUUID()}.txt`)
  await writeFile(path, text)
  return path
}

function truncationNotice(t: TruncationResult, path: string): string {
  const start = t.totalLines - t.outputLines + 1
  const range = `Showing lines ${start}-${t.totalLines} of ${t.totalLines}`
  const limit = t.truncatedBy === "bytes" ? ` (${formatSize(t.maxBytes)} limit)` : ""
  return `[${range}${limit}. Full output: ${path}]`
}

/**
 * Map an MCP CallToolResult to a pi tool result.
 *
 * An error result is thrown, because pi marks a tool result as an error only
 * when execute throws. Long text keeps its tail, like pi's bash tool, with
 * the untruncated text saved to a file whose path is given to the model.
 */
export async function mapCallResult(
  tool: string,
  result: Record<string, unknown>,
  options: MapOptions = {},
): Promise<MappedResult> {
  const blocks = Array.isArray(result.content) ? (result.content as Block[]) : []
  let content = blocks.map(mapBlock)
  if (content.length === 0 && result.structuredContent !== undefined) {
    content = [{ type: "text", text: JSON.stringify(result.structuredContent, null, 2) }]
  }

  if (result.isError === true) {
    const text = textOf(content).trim()
    throw new Error(text || `MCP tool ${tool} returned an error`)
  }

  const details: McpResultDetails = { server: CAST_SERVER, tool, result }
  const fullText = textOf(content)
  const limits = {
    maxLines: options.truncation?.maxLines ?? DEFAULT_MAX_LINES,
    maxBytes: options.truncation?.maxBytes ?? DEFAULT_MAX_BYTES,
  }
  const truncation = truncateTail(fullText, limits)
  if (truncation.truncated) {
    const save = options.saveFullOutput ?? saveFullOutputToTemp
    const path = await save(tool, fullText)
    const images = content.filter((c) => c.type === "image")
    content = [
      { type: "text", text: `${truncation.content}\n\n${truncationNotice(truncation, path)}` },
      ...images,
    ]
    details.truncation = truncation
    details.fullOutputPath = path
  }

  if (content.length === 0) content = [{ type: "text", text: "(no output)" }]
  return { content, details }
}
