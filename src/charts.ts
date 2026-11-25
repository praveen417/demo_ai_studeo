import { escapeHtml } from "./fmt.js";

export const OK = "#2e7d32";
export const WARN = "#ed8b00";
export const FAIL = "#c62828";
export const INC = "#757575";
export const RUN = "#1976d2";
export const BLUE = "#1f4e8c";
export const FREE = "#d9dee5";

function shortText(text: string, n = 24): string {
  const s = String(text || "");
  return s.length <= n ? s : s.slice(0, n - 1) + "\u2026";
}

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

export function donutSvg(segments: DonutSegment[], centerValue: string, centerLabel: string): string {
  const total = segments.reduce((acc, s) => acc + s.value, 0);
  const r = 70.0;
  const w = 26.0;
  const cx = 100;
  const circ = 2 * Math.PI * r;
  const out: string[] = [
    `<svg viewBox="0 0 200 200" class="chart-donut" role="img" aria-label="Backup jobs by outcome">`,
    `<circle cx="${cx}" cy="${cx}" r="${r.toFixed(0)}" fill="none" stroke="${FREE}" stroke-width="${w.toFixed(0)}"/>`,
  ];
  let offset = 0.0;
  if (total > 0) {
    for (const seg of segments) {
      if (!seg.value) continue;
      const length = (circ * seg.value) / total;
      out.push(
        `<circle cx="${cx}" cy="${cx}" r="${r.toFixed(0)}" fill="none" stroke="${seg.color}" stroke-width="${w.toFixed(0)}" ` +
          `stroke-dasharray="${length.toFixed(2)} ${(circ - length).toFixed(2)}" ` +
          `stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cx})">` +
          `<title>${escapeHtml(seg.label)}: ${seg.value}</title></circle>`
      );
      offset += length;
    }
  }
  out.push(
    `<text x="${cx}" y="${cx + 4}" text-anchor="middle" class="donut-v">${escapeHtml(centerValue)}</text>` +
      `<text x="${cx}" y="${cx + 22}" text-anchor="middle" class="donut-l">${escapeHtml(centerLabel)}</text></svg>`
  );
  return out.join("");
}

export interface MediaOutcomeRow {
  media: string;
  successful: number;
  partial: number;
  failed: number;
  other: number;
  total: number;
}

export function outcomesByMediaSvg(rows: MediaOutcomeRow[]): string {
  const sliced = rows.slice(0, 12);
  if (!sliced.length) return "";
  const mx = Math.max(...sliced.map((r) => r.total), 1);
  const left = 150;
  const right = 120;
  const barH = 18;
  const gap = 10;
  const w = 760;
  const h = sliced.length * (barH + gap) + 24;
  const scale = (w - left - right) / mx;
  const out: string[] = [
    `<svg viewBox="0 0 ${w} ${h}" class="chart-hbar" role="img" aria-label="Job outcomes per media server">`,
  ];
  sliced.forEach((r, i) => {
    const y = 8 + i * (barH + gap);
    out.push(
      `<text x="${left - 8}" y="${y + barH - 5}" text-anchor="end" class="axis" style="font-size:12px">${escapeHtml(shortText(r.media, 22))}</text>`
    );
    let x = left;
    const parts: Array<[keyof MediaOutcomeRow, string, string]> = [
      ["successful", OK, "Successful"],
      ["partial", WARN, "Partial"],
      ["failed", FAIL, "Failed"],
      ["other", INC, "Other"],
    ];
    for (const [key, color, label] of parts) {
      const v = Number(r[key]) || 0;
      if (v > 0) {
        const bw = v * scale;
        out.push(
          `<rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${barH}" fill="${color}"><title>${escapeHtml(r.media)} ${label}: ${v}</title></rect>`
        );
        x += bw;
      }
    }
    const pct = r.total ? (100.0 * r.successful) / r.total : 0;
    out.push(
      `<text x="${(x + 8).toFixed(1)}" y="${y + barH - 5}" class="axis" style="font-size:12px">${r.total} jobs &#183; ${pct.toFixed(0)}% ok</text>`
    );
  });
  out.push("</svg>");
  return out.join("");
}

export function rateSvg(points: Array<[string, number | null]>, target: number): string {
  const pts = points.filter((p): p is [string, number] => p[1] !== null && p[1] !== undefined);
  if (pts.length < 2) return "";
  let lo = Math.max(0.0, Math.min(...pts.map((p) => p[1]), target) - 5);
  lo = Math.floor(lo / 5) * 5;
  const w = 760;
  const h = 220;
  const left = 44;
  const bottom = 30;
  const top = 14;
  const x = (i: number) => left + (i / (pts.length - 1)) * (w - left - 16);
  const y = (v: number) => top + (1 - (Math.min(Math.max(v, lo), 100) - lo) / (100.0 - lo)) * (h - bottom - top);
  const out: string[] = [
    `<svg viewBox="0 0 ${w} ${h}" class="chart-rate" role="img" aria-label="Daily success rate">`,
  ];
  const ticks = Array.from(new Set([lo, Math.round((lo + 100) / 2), 100.0])).sort((a, b) => a - b);
  for (const tick of ticks) {
    out.push(
      `<line x1="${left}" y1="${y(tick).toFixed(1)}" x2="${w - 16}" y2="${y(tick).toFixed(1)}" class="grid"/>` +
        `<text x="${left - 5}" y="${(y(tick) + 3).toFixed(1)}" class="axis" text-anchor="end">${tick.toFixed(0)}%</text>`
    );
  }
  out.push(
    `<line x1="${left}" y1="${y(target).toFixed(1)}" x2="${w - 16}" y2="${y(target).toFixed(1)}" class="warnline"/>` +
      `<text x="${w - 18}" y="${(y(target) - 3).toFixed(1)}" class="axis" text-anchor="end" style="fill:#ed8b00">target ${target.toFixed(0)}%</text>`
  );
  const polyPts = pts.map((p, i) => `${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  out.push(`<polyline fill="none" stroke="${BLUE}" stroke-width="2.5" points="${polyPts}"/>`);
  const step = Math.max(1, Math.floor(pts.length / 10));
  pts.forEach(([d, v], i) => {
    const color = v >= target ? OK : v >= target - 5 ? WARN : FAIL;
    out.push(
      `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5" fill="${color}"><title>${escapeHtml(d)}: ${v.toFixed(1)}%</title></circle>`
    );
    if (i % step === 0 || i === pts.length - 1) {
      out.push(
        `<text x="${x(i).toFixed(1)}" y="${h - 10}" class="axis" text-anchor="middle">${escapeHtml(d.slice(5))}</text>`
      );
    }
  });
  out.push("</svg>");
  return out.join("");
}

export interface CapacityRow {
  media: string;
  total_gb: number;
  used_gb: number;
  free_gb: number;
  used_pct: number;
  pools: number;
  status: string;
}

export function capacitySvg(rows: CapacityRow[], warnPct: number, critPct: number): string {
  if (!rows.length) return "";
  const left = 170;
  const right = 210;
  const barH = 22;
  const gap = 12;
  const w = 760;
  const h = rows.length * (barH + gap) + 50;
  const bw = w - left - right;
  const out: string[] = [
    `<svg viewBox="0 0 ${w} ${h}" class="chart-capacity" role="img" aria-label="Storage capacity per media server">`,
  ];
  rows.forEach((r, i) => {
    const y = 10 + i * (barH + gap);
    const pct = Math.min(Math.max(r.used_pct, 0), 100);
    const color = r.used_pct >= critPct ? FAIL : r.used_pct >= warnPct ? WARN : OK;
    out.push(
      `<text x="${left - 8}" y="${y + barH - 7}" text-anchor="end" class="axis" style="font-size:12px">${escapeHtml(shortText(r.media, 26))}</text>`
    );
    out.push(
      `<rect x="${left}" y="${y}" width="${bw}" height="${barH}" fill="${FREE}"><title>${escapeHtml(r.media)}: free ${(r.free_gb / 1024.0).toFixed(1)} TB</title></rect>`
    );
    out.push(
      `<rect x="${left}" y="${y}" width="${((bw * pct) / 100.0).toFixed(1)}" height="${barH}" fill="${color}"><title>${escapeHtml(r.media)}: used ${(r.used_gb / 1024.0).toFixed(1)} TB (${r.used_pct.toFixed(1)}%)</title></rect>`
    );
    out.push(
      `<text x="${left + bw + 8}" y="${y + barH - 7}" class="axis" style="font-size:12px">${(r.used_gb / 1024.0).toFixed(1)} / ${(r.total_gb / 1024.0).toFixed(1)} TB &#183; ${r.used_pct.toFixed(0)}%</text>`
    );
  });
  const base = 10 + rows.length * (barH + gap);
  const lines: Array<[number, string, string]> = [
    [warnPct, "warnline", `warning ${warnPct.toFixed(0)}%`],
    [critPct, "critline", `critical ${critPct.toFixed(0)}%`],
  ];
  lines.forEach(([pct, cls, label], n) => {
    const xx = left + (bw * pct) / 100.0;
    const ty = base + 8 + n * 13;
    out.push(
      `<line x1="${xx.toFixed(1)}" y1="4" x2="${xx.toFixed(1)}" y2="${ty - 9}" class="${cls}"/>` +
        `<text x="${xx.toFixed(1)}" y="${ty}" class="axis" text-anchor="middle">${label}</text>`
    );
  });
  out.push("</svg>");
  return out.join("");
}

export interface TrendPoint {
  date: string;
  total: number;
  successful: number;
  partial: number;
  failed: number;
  other: number;
}

export function trendSvg(points: TrendPoint[]): string {
  if (!points.length) return "";
  const w = 760;
  const h = 210;
  const left = 36;
  const bottom = 34;
  const mx = Math.max(...points.map((p) => p.total), 1);
  const slot = (w - left - 10) / points.length;
  const bw = Math.min(40, slot * 0.7);
  const out: string[] = [
    `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Daily backup outcomes" class="trend">`,
  ];
  for (const frac of [0, 0.5, 1]) {
    const y = h - bottom - frac * (h - bottom - 14);
    out.push(`<line x1="${left}" y1="${y.toFixed(1)}" x2="${w - 6}" y2="${y.toFixed(1)}" class="grid"/>`);
    out.push(`<text x="${left - 4}" y="${(y + 3).toFixed(1)}" class="axis" text-anchor="end">${Math.round(mx * frac)}</text>`);
  }
  points.forEach((p, i) => {
    const x = left + i * slot + (slot - bw) / 2;
    let y = h - bottom;
    const parts: Array<[keyof TrendPoint, string]> = [
      ["successful", "c-ok"],
      ["partial", "c-warn"],
      ["failed", "c-fail"],
      ["other", "c-inc"],
    ];
    for (const [key, cls] of parts) {
      const v = Number(p[key]) || 0;
      if (v > 0) {
        const bh = (v / mx) * (h - bottom - 14);
        y -= bh;
        out.push(
          `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" class="${cls}"><title>${escapeHtml(p.date)} ${key}: ${v}</title></rect>`
        );
      }
    }
    if (points.length <= 16 || i % 2 === 0) {
      out.push(
        `<text x="${(x + bw / 2).toFixed(1)}" y="${h - bottom + 14}" class="axis" text-anchor="middle">${escapeHtml(p.date.slice(5))}</text>`
      );
    }
  });
  out.push("</svg>");
  return out.join("");
}
