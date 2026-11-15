import { run } from "./git.js";
import type { Packet, PacketChunk, PacketFile, PacketGroup } from "./packet.js";

interface HunkAcc {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: string[];
}

interface FileAcc {
  path: string;
  oldPath: string | null;
  status: PacketFile["status"];
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: HunkAcc[];
}

function parsePaths(line: string): { a: string; b: string } {
  const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
  if (m === null || m[1] === undefined || m[2] === undefined) {
    throw new Error(`cannot parse diff header: ${line}`);
  }
  return { a: m[1], b: m[2] };
}

export function parseDiff(diff: string): FileAcc[] {
  const files: FileAcc[] = [];
  let file: FileAcc | null = null;
  let hunk: HunkAcc | null = null;
  let renamedFrom: string | null = null;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const { a, b } = parsePaths(line);
      file = {
        path: b,
        oldPath: renamedFrom,
        status: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      renamedFrom = null;
      files.push(file);
      hunk = null;
      continue;
    }
    if (file === null) continue;
    if (line.startsWith("old mode") || line.startsWith("new mode") || line.startsWith("index ")) continue;
    if (line.startsWith("new file mode")) {
      file.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      file.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      renamedFrom = line.slice("rename from ".length);
      if (file !== null) {
        file.oldPath = renamedFrom;
        file.status = "renamed";
      }
      continue;
    }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      file.binary = true;
      continue;
    }
    const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hm !== null) {
      hunk = {
        header: line,
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        section: (hm[5] ?? "").trim(),
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk === null) continue;
    if (line.startsWith("+")) file.additions += 1;
    if (line.startsWith("-")) file.deletions += 1;
    hunk.lines.push(line);
  }
  return files;
}

const GENERATED = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)bun\.lockb?$/,
  /(^|\/)flake\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)result(-[^/]+)?$/,
];

export interface PacketMeta {
  repoPath: string;
  branch: string;
  baseSha: string;
  headSha: string;
  subject: string;
  now: number;
}

export function buildPacketFromDiff(diff: string, meta: PacketMeta): Packet {
  const files = parseDiff(diff);

  const packetFiles: PacketFile[] = [];
  const packetChunks: PacketChunk[] = [];
  const groups: PacketGroup[] = [];

  files.forEach((f, fi) => {
    const fileId = `f${fi + 1}`;
    packetFiles.push({
      id: fileId,
      path: f.path,
      old_path: f.oldPath,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      binary: f.binary,
    });
    const chunkIds: string[] = [];
    f.hunks.forEach((h, hi) => {
      const chunkId = `c${packetChunks.length + 1}`;
      chunkIds.push(chunkId);
      packetChunks.push({
        id: chunkId,
        file_id: fileId,
        old_start: h.oldStart,
        old_lines: h.oldLines,
        new_start: h.newStart,
        new_lines: h.newLines,
        section: h.section,
        patch: [h.header, ...h.lines].join("\n"),
      });
    });
    const generated = GENERATED.some((re) => re.test(f.path));
    groups.push({
      id: `g${fi + 1}`,
      intent: f.binary ? `${f.path} (binary)` : `${f.path} (+${f.additions} -${f.deletions})`,
      role: generated ? "generated" : "core",
      chunks: chunkIds,
    });
  });

  const head7 = meta.headSha.slice(0, 7);
  const ts = new Date(meta.now);
  const stamp = ts.toISOString().replace(/[-:]/g, "").slice(0, 15);
  const id = `rp-${stamp}-${head7}`;

  return {
    kind: "review-station.packet",
    schema_version: 1,
    id,
    created_at: Math.floor(meta.now / 1000),
    repo_path: meta.repoPath,
    branch: meta.branch,
    base_sha: meta.baseSha,
    head_sha: meta.headSha,
    briefing: {
      title: meta.subject,
      summary: null,
      flags: [],
    },
    files: packetFiles,
    chunks: packetChunks,
    groups,
  };
}

export function buildPacket(repoPath: string, range: string, now = Date.now()): Packet {
  const [baseRef, headRef] = range.split("..");
  if (headRef === undefined) throw new Error(`range must be base..head, got: ${range}`);
  const baseSha = run(repoPath, ["rev-parse", `${baseRef}^{commit}`]).trim();
  const headSha = run(repoPath, ["rev-parse", `${headRef}^{commit}`]).trim();
  const branch = run(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const subject = run(repoPath, ["log", "-1", "--format=%s", headSha]).trim();
  const diff = run(repoPath, ["diff", "--no-color", "--full-index", "-M50", `${baseSha}..${headSha}`]);
  return buildPacketFromDiff(diff, { repoPath, branch, baseSha, headSha, subject, now });
}
