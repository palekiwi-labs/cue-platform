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
