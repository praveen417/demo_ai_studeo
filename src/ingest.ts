import { parse } from "csv-parse/sync";
import { cleanCell, toFloat, toInt, validDate } from "./fmt.js";

export const REQUIRED_COLS = [
  "Server Name",
  "Policy Name",
  "Schedule Type",
  "Start Time",
  "End Time",
  "Elapsed Time",
  "Master Server",
  "Media Server",
  "Backup Size",
  "Backup Speed",
  "Job ID",
  "Job Status",
  "Status Code",
];

export class IngestError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ParsedJobRow {
  client: string;
  policy: string;
  schedule_type: string;
  start_time: string;
  end_time: string;
  elapsed_txt: string;
  elapsed_sec: number | null;
  master: string;
  media: string;
  size_txt: string;
  size_kb: number;
  speed_txt: string;
  speed_kbps: number | null;
  job_id: number | null;
  status: string;
  status_code: string;
  schedule_name: string;
  policy_type: string;
  backup_id: string;
}

export function parseReportCsv(rawBytes: Buffer | string): { text: string; rows: ParsedJobRow[] } {
  let text: string;
  if (Buffer.isBuffer(rawBytes)) {
    text = rawBytes.toString("utf-8");
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
  } else {
    text = rawBytes.replace(/^\uFEFF/, "");
  }

  let records: Array<Record<string, string>>;
  try {
    records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    }) as Array<Record<string, string>>;
  } catch (err) {
    throw new IngestError(`Invalid CSV: ${(err as Error).message}`);
  }

  const headers = records.length > 0 ? Object.keys(records[0]) : parseHeaderOnly(text);
  const missing = REQUIRED_COLS.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    throw new IngestError("CSV is missing required column(s): " + missing.join(", "));
  }

  const rows: ParsedJobRow[] = [];
  for (const rec of records) {
    const status = cleanCell(rec["Job Status"]);
    if (!status) continue;
    rows.push({
      client: cleanCell(rec["Server Name"]),
      policy: cleanCell(rec["Policy Name"]),
      schedule_type: cleanCell(rec["Schedule Type"]),
      start_time: cleanCell(rec["Start Time"]),
      end_time: cleanCell(rec["End Time"]),
      elapsed_txt: cleanCell(rec["Elapsed Time"]),
      elapsed_sec: toInt(rec["Elapsed (sec)"]),
      master: cleanCell(rec["Master Server"]),
      media: cleanCell(rec["Media Server"]),
      size_txt: cleanCell(rec["Backup Size"]),
      size_kb: toInt(rec["Backup Size (KB)"], 0) ?? 0,
      speed_txt: cleanCell(rec["Backup Speed"]),
      speed_kbps: toFloat(rec["Backup Speed (KB/sec)"]),
      job_id: toInt(rec["Job ID"]),
      status,
      status_code: cleanCell(rec["Status Code"]),
      schedule_name: cleanCell(rec["Schedule Name"]),
      policy_type: cleanCell(rec["Policy Type"]),
      backup_id: cleanCell(rec["Backup ID"]),
    });
  }
  return { text, rows };
}

function parseHeaderOnly(text: string): string[] {
  const firstLine = text.split(/\r?\n/)[0] || "";
  if (!firstLine.trim()) return [];
  try {
    const parsed = parse(firstLine, { columns: false }) as string[][];
    return parsed[0] || [];
  } catch {
    return [];
  }
}

export interface ParsedPool {
  media_server: string;
  pool: string;
  stype: string;
  total_gb: number;
  free_gb: number;
  used_gb: number;
  used_pct: number;
  unit_assumed: boolean;
}

const UNITS: Record<string, number> = {
  b: 1,
  byte: 1,
  bytes: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
  pb: 1024 ** 5,
};
const GB = 1024 ** 3;

export function mediaFromPool(pool: string): string {
  const parts = (pool || "").trim().split(/[-_\s.]+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (/[A-Za-z]/.test(p) && /\d/.test(p)) {
      return p;
    }
  }
  return "";
}

function parseBytes(key: string, value: string): [number | null, boolean] {
  const m = /^\s*([0-9][0-9,]*\.?[0-9]*)\s*([A-Za-z]*)/.exec(value || "");
  if (!m) return [null, false];
  const num = Number(m[1].replace(/,/g, ""));
  let unit = m[2].toLowerCase();
  if (!(unit in UNITS)) unit = "";
  if (!unit) {
    const mk = /\(\s*(bytes|[kmgtp]?b)\s*\)/i.exec(key);
    unit = mk ? mk[1].toLowerCase() : "";
  }
  if (!unit) return [num, true];
  return [num * UNITS[unit], false];
}

export function parseNbdevquery(text: string, mediaHint = ""): ParsedPool[] {
  if (!text || !text.trim()) {
    throw new IngestError("Storage output is empty", 422);
  }
  const blocks: Array<Record<string, string>> = [];
  let cur: Record<string, string> = {};
  let stype = "";
  const flush = () => {
    if (Object.keys(cur).length > 0) {
      if (!cur._stype_hint) cur._stype_hint = stype;
      blocks.push(cur);
      cur = {};
    }
  };

  for (const line of text.split(/\r?\n/)) {
    const sm = /^\s*#+\s*stype\s*=\s*(\S+)/i.exec(line);
    if (sm) {
      flush();
      stype = sm[1];
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const kv = /^\s*([A-Za-z][A-Za-z0-9 _/()%.\-]*?)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const val = kv[2];
    if (key === "flag" || key === "flags") {
      cur[key] = cur[key] ? `${cur[key]}, ${val}` : val;
      continue;
    }
    if (key in cur) {
      flush();
    }
    cur[key] = val;
  }
  flush();

  const pools: ParsedPool[] = [];
  for (const b of blocks) {
    const pool = b["disk pool name"] || b["pool name"] || b["disk pool"] || "";
    if (!pool) continue;
    let totalBytes: number | null = null;
    let freeBytes: number | null = null;
    let unitAssumed = false;
    for (const [k, v] of Object.entries(b)) {
      if (k.includes("total") && (k.includes("capacity") || k.includes("size"))) {
        const [bytes, assumed] = parseBytes(k, v);
        if (bytes !== null) {
          totalBytes = bytes;
          unitAssumed = unitAssumed || assumed;
        }
      }
      if (k.includes("free") && (k.includes("space") || k.includes("capacity"))) {
        const [bytes, assumed] = parseBytes(k, v);
        if (bytes !== null) {
          freeBytes = bytes;
          unitAssumed = unitAssumed || assumed;
        }
      }
    }
    if (totalBytes === null || totalBytes <= 0 || freeBytes === null || freeBytes < 0) continue;
    const totalGb = Math.round((totalBytes / GB) * 100) / 100;
    const freeGb = Math.round((Math.min(freeBytes, totalBytes) / GB) * 100) / 100;
    const usedGb = Math.round(Math.max(0, totalGb - freeGb) * 100) / 100;
    const usedPct = totalGb > 0 ? Math.round((100.0 * usedGb / totalGb) * 100) / 100 : 0;
    const media =
      b["storage server"] ||
      b["storage servers"] ||
      b["media server"] ||
      mediaHint.trim() ||
      mediaFromPool(pool) ||
      "unknown";
    pools.push({
      media_server: media,
      pool,
      stype: b["storage type"] || b["disk type"] || b._stype_hint || "",
      total_gb: totalGb,
      free_gb: freeGb,
      used_gb: usedGb,
      used_pct: usedPct,
      unit_assumed: unitAssumed,
    });
  }

  if (pools.length === 0) {
    throw new IngestError("Could not parse any disk pools from the supplied nbdevquery output", 422);
  }
  return pools;
}

export function isValidMasterName(master: string): boolean {
  return Boolean(master) && master.length <= 100 && /^[\w.\-]+$/.test(master);
}

export function validateDateOrThrow(dateStr: string, fieldLabel = "report date"): string {
  const d = validDate(dateStr);
  if (!d) {
    throw new IngestError(`${fieldLabel} is required in YYYY-MM-DD format`);
  }
  return d;
}
