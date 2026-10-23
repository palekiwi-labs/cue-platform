#!/usr/bin/env bash
set -euo pipefail

# Cue Log Compaction Script
# Moves a contiguous range of log entries [from..to] into .archive/<from>-<to>/
# and places the summary entry at log/<to>.json.

usage() {
  cat <<EOF >&2
Usage: $(basename "$0") <log_dir> <from_ts> <to_ts> <summary_file.json> [--dry-run]

Arguments:
  log_dir            Path to context's log directory (e.g. \$CUE_STORE/scope/context/log)
  from_ts            20-digit start timestamp of range (e.g. 01789133828399767010)
  to_ts              20-digit end timestamp of range (e.g. 01789133828399769010)
  summary_file.json  JSON file containing the summary StoredLogEntry
  --dry-run          Print planned actions without modifying files

EOF
  exit 1
}

[ $# -ge 4 ] || usage

LOG_DIR="$1"
FROM="$2"
TO="$3"
SUMMARY_FILE="$4"
DRY_RUN=0

if [ "${5:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

[ -d "$LOG_DIR" ] || { echo "Error: log directory not found: $LOG_DIR" >&2; exit 1; }
[ -f "$SUMMARY_FILE" ] || { echo "Error: summary file not found: $SUMMARY_FILE" >&2; exit 1; }

RANGE="$FROM-$TO"
ARC_DIR="$LOG_DIR/.archive/$RANGE"

if [ -d "$ARC_DIR" ]; then
  echo "Error: archive directory already exists: $ARC_DIR" >&2
  exit 1
fi

# Find all .json entries in log directory sorted lexicographically
mapfile -t all_files < <(find "$LOG_DIR" -maxdepth 1 -name "*.json" -printf "%f\n" | sort)
[ "${#all_files[@]}" -gt 0 ] || { echo "Error: no log entries found in $LOG_DIR" >&2; exit 1; }

# Guard: never compact the newest entry
NEWEST_FILE="${all_files[-1]}"
if [ "$NEWEST_FILE" = "$TO.json" ]; then
  echo "Error: range ends at the newest log entry ($NEWEST_FILE). Compaction must never include the newest entry." >&2
  exit 1
fi

# Select contiguous files in range [FROM.json .. TO.json]
mapfile -t target_files < <(for f in "${all_files[@]}"; do
  if [[ ! "$f" < "$FROM.json" && ! "$f" > "$TO.json" ]]; then
    echo "$f"
  fi
done)

[ "${#target_files[@]}" -ge 2 ] || {
  echo "Error: expected at least 2 entries in range, found ${#target_files[@]}" >&2
  exit 1
}

# Ensure boundary matches
if [ "${target_files[0]}" != "$FROM.json" ]; then
  echo "Error: starting file ${target_files[0]} does not match expected $FROM.json" >&2
  exit 1
fi

if [ "${target_files[-1]}" != "$TO.json" ]; then
  echo "Error: ending file ${target_files[-1]} does not match expected $TO.json" >&2
  exit 1
fi

echo "Range: $RANGE (${#target_files[@]} entries: $FROM.json -> $TO.json)"
echo "Target archive: $ARC_DIR"
echo "Target summary: $LOG_DIR/$TO.json"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry-run mode: no files modified."
  exit 0
fi

# 1. Create archive directory
mkdir -p "$ARC_DIR"

# 2. Build manifest.json
MANIFEST="$ARC_DIR/manifest.json"
NOW_TS="$(date +%s)000000000"
COUNT="${#target_files[@]}"

{
  printf '{\n  "from": %s,\n  "to": %s,\n  "count": %s,\n  "compacted_at": %s,\n  "summary": "log/%s.json",\n  "entries": [\n' \
    "$((10#$FROM))" "$((10#$TO))" "$COUNT" "$NOW_TS" "$TO"

  i=0
  for f in "${target_files[@]}"; do
    [ "$i" -gt 0 ] && printf ',\n'
    jq -c --arg f "$f" '{file: $f, title: .title, trace: .trace}' "$LOG_DIR/$f" | sed 's/^/    /'
    i=$((i+1))
  done
  printf '\n  ]\n}\n'
} > "$MANIFEST"

# 3. Copy original files byte-for-byte to archive (preserves legacy fields)
for f in "${target_files[@]}"; do
  cp -p "$LOG_DIR/$f" "$ARC_DIR/$f"
done

# 4. Remove original files from log/
for f in "${target_files[@]}"; do
  rm "$LOG_DIR/$f"
done

# 5. Place summary file
cp "$SUMMARY_FILE" "$LOG_DIR/$TO.json"

echo "Compacted $RANGE successfully into $LOG_DIR/$TO.json."
