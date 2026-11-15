export interface PacketFile {
  id: string;
  path: string;
  old_path: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface PacketChunk {
  id: string;
  file_id: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  section: string;
  patch: string;
}

export interface PacketGroup {
  id: string;
  intent: string;
  role: "core" | "generated";
  chunks: string[];
}

export interface Packet {
  kind: "review-station.packet";
  schema_version: 1;
  id: string;
  created_at: number;
  repo_path: string;
  branch: string;
  base_sha: string;
  head_sha: string;
  briefing: {
    title: string;
    summary: string | null;
    flags: { level: string; text: string; chunks: string[] }[];
  };
  files: PacketFile[];
  chunks: PacketChunk[];
  groups: PacketGroup[];
}

export interface PacketState {
  schema: "review-station/state@0";
  packet_id: string;
  updated_at: number;
  read: Record<string, { at: number }>;
  cursor: { chunk_id: string | null };
}

export function loadPacket(text: string): Packet {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) throw new Error("packet is not an object");
  const p = raw as Partial<Packet>;
  if (p.kind !== "review-station.packet" || p.schema_version !== 1) {
    throw new Error("not a review-station packet v1");
  }
  for (const key of ["id", "repo_path", "base_sha", "head_sha", "files", "chunks", "groups"] as const) {
    if (p[key] === undefined) throw new Error(`packet missing field: ${key}`);
  }
  return p as Packet;
}

export function emptyState(packetId: string): PacketState {
  return {
    schema: "review-station/state@0",
    packet_id: packetId,
    updated_at: 0,
    read: {},
    cursor: { chunk_id: null },
  };
}

export function loadState(text: string | null, packetId: string): PacketState {
  if (text === null) return emptyState(packetId);
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) return emptyState(packetId);
  const s = raw as Partial<PacketState>;
  if (s.packet_id !== packetId) return emptyState(packetId);
  return {
    schema: "review-station/state@0",
    packet_id: packetId,
    updated_at: s.updated_at ?? 0,
    read: s.read ?? {},
    cursor: s.cursor ?? { chunk_id: null },
  };
}
