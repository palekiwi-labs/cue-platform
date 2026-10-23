import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unlink, writeFile } from "node:fs/promises"

/**
 * Write content to a unique temp file, run fn with its path, then remove it.
 *
 * Artifact content never becomes a CLI argument: cue reads it from the file,
 * so payloads with quotes, backticks or newlines cannot be mangled by an
 * argv boundary. Cleanup is best-effort.
 */
export async function withTempFile<T>(
  content: string,
  prefix: string,
  ext: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const path = join(tmpdir(), `${prefix}-${randomUUID()}.${ext}`)
  await writeFile(path, content)
  try {
    return await fn(path)
  } finally {
    try {
      await unlink(path)
    } catch {
      // best-effort cleanup
    }
  }
}
