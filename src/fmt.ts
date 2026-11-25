export function fmtSize(kb: number | null | undefined): string {
  const val = kb || 0;
  if (val < 1024) {
    return `${Math.round(val)} KB`;
  }
  const mb = val / 1024.0;
  if (mb < 1024) {
    return `${mb.toFixed(2)} MB`;
  }
  const gb = mb / 1024.0;
  if (gb < 1024) {
    return `${gb.toFixed(2)} GB`;
  }
  return `${(gb / 1024.0).toFixed(2)} TB`;
}

export function fmtSpeed(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || Number.isNaN(kbps)) {
    return "N/A";
  }
  if (kbps < 1024) {
    return `${kbps.toFixed(2)} KB/sec`;
  }
  return `${(kbps / 1024.0).toFixed(2)} MB/sec`;
}

export function escapeHtml(str: unknown): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function nowStr(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function dateStr(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function validDate(text: string | undefined | null): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const d = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString().slice(0, 10);
  return iso === trimmed ? trimmed : null;
}

export function toInt(v: unknown, fallback: number | null = null): number | null {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

export function toFloat(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function cleanCell(value: unknown): string {
  let v = String(value ?? "").trim();
  if (v.length > 1 && v[0] === "'" && "=+-@\t\r".includes(v[1])) {
    v = v.slice(1);
  }
  return v;
}
