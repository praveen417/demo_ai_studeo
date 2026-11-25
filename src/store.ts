import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { dateStr, fmtSize, fmtSpeed, nowStr, validDate } from "./fmt.js";
import { IngestError, isValidMasterName, ParsedPool, parseReportCsv, validateDateOrThrow } from "./ingest.js";

export const ROLES = ["Administrator", "Backup Engineer", "Team Lead", "Management", "Requester"] as const;
export type Role = (typeof ROLES)[number];

export const PERMS: Record<string, Set<Role>> = {
  upload: new Set(["Administrator", "Backup Engineer"]),
  remark: new Set(["Administrator", "Backup Engineer", "Team Lead"]),
  resolve: new Set(["Administrator", "Team Lead"]),
  audit: new Set(["Administrator", "Team Lead"]),
  users: new Set(["Administrator"]),
  delete_report: new Set(["Administrator"]),
  mail_send: new Set(["Administrator", "Backup Engineer", "Team Lead"]),
  mail_admin: new Set(["Administrator"]),
  req_edit_all: new Set(["Administrator", "Backup Engineer", "Team Lead"]),
  req_fulfil: new Set(["Administrator", "Backup Engineer"]),
  req_delete: new Set(["Administrator"]),
  pool_admin: new Set(["Administrator", "Backup Engineer"]),
};

export const OK = "Successful";
export const PARTIAL = "Partially Successful";
export const FAILED = "Failed";
export const RUNNING = "Running";
export const MAX_FAILS = 5;
export const LOCK_MINUTES = 10;
export const PAGE_SIZE = 100;

export interface User {
  id: number;
  username: string;
  full_name: string;
  email: string;
  role: Role;
  pw_hash: string;
  active: boolean;
  failed_count: number;
  locked_until: string | null;
  created_at: string;
  last_login: string | null;
}

export interface Report {
  id: number;
  master: string;
  report_date: string;
  ingested_at: string;
  source: string;
  row_count: number;
  raw_csv: string;
}

export interface Job {
  id: number;
  report_id: number;
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

export interface Remark {
  id: number;
  master: string;
  report_date: string;
  nbu_job_id: number;
  client: string;
  policy: string;
  text: string;
  status: "Open" | "Resolved";
  created_by: string;
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  source: string;
}

export interface StorageSnapshot {
  id: number;
  master: string;
  snapshot_date: string;
  media_server: string;
  pool: string;
  stype: string;
  total_gb: number;
  used_gb: number;
  free_gb: number;
  used_pct: number;
  unit_assumed: boolean;
  source: string;
  ingested_at: string;
}

export interface AuditEntry {
  id: number;
  ts: string;
  username: string | null;
  action: string;
  detail: string;
  ip: string | null;
}

export interface FlashMsg {
  cat: "ok" | "error" | "warn";
  text: string;
}

export interface SessionData {
  id: string;
  uid: number | null;
  csrf: string;
  flashes: FlashMsg[];
  expiresAt: number;
}

export interface SummaryStats {
  total: number;
  successful: number;
  partial: number;
  failed: number;
  running: number;
  incomplete: number;
  total_data: string;
  avg_speed: string;
  success_pct: number | null;
}

export interface RangeKpis {
  total: number;
  successful: number;
  partial: number;
  failed: number;
  incomplete: number;
  kb: number;
  avg_kbps: number | null;
  success_pct: number | null;
  days_reported: number;
  days_expected: number;
}

class MemoryStore {
  users: Map<number, User> = new Map();
  reports: Map<number, Report> = new Map();
  jobs: Job[] = [];
  remarks: Remark[] = [];
  storageSnapshots: StorageSnapshot[] = [];
  auditLog: AuditEntry[] = [];
  sessions: Map<string, SessionData> = new Map();

  private seq = {
    user: 1,
    report: 1,
    job: 1,
    remark: 1,
    storage: 1,
    audit: 1,
  };

  constructor() {
    this.seedBootstrapAdmin();
    this.seedDemoData();
  }

  private seedBootstrapAdmin() {
    const adminUser = (process.env.ADMIN_USER || "admin").trim();
    const adminPass = process.env.ADMIN_PASSWORD || "admin12345";
    const id = this.seq.user++;
    this.users.set(id, {
      id,
      username: adminUser,
      full_name: "Administrator",
      email: "admin@mtn.local",
      role: "Administrator",
      pw_hash: bcrypt.hashSync(adminPass, 10),
      active: true,
      failed_count: 0,
      locked_until: null,
      created_at: nowStr(),
      last_login: null,
    });
    if (!process.env.ADMIN_PASSWORD) {
      console.warn(`[MBOP] Bootstrap administrator '${adminUser}' created (in-memory). Set ADMIN_USER/ADMIN_PASSWORD in env to customize.`);
    }
  }

  private seedDemoData() {
    // Load the real sample CSV if available
    const samplePath = path.join(process.cwd(), "samples", "NetBackup_Daily_Report_20261114.csv");
    if (fs.existsSync(samplePath)) {
      try {
        const buf = fs.readFileSync(samplePath);
        this.ingestReport(buf, "2026-11-14", "nbumaster01", "seed:sample");
      } catch (err) {
        console.warn("[MBOP] Could not seed sample CSV:", (err as Error).message);
      }
    }

    // Generate deterministic multi-day reports around the sample date / current date
    const anchor = new Date("2026-11-24T12:00:00Z");
    let seed = 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const policies = ["PRD_LINUX_FULL", "PRD_WIN_FULL", "PRD_SQL", "PRD_VMWARE", "PRD_ORA_FULL"];
    const scheds = ["Full Backup", "Differential Incremental Backup", "Cumulative Incremental Backup"];
    const medias = ["mediasrv01", "mediasrv02", "mediasrv03"];
    const failCodes = [96, 58, 13];
    let jid = 5000;

    for (let d = 13; d >= 0; d--) {
      const day = new Date(anchor.getTime() - d * 86400_000);
      const dayStr = day.toISOString().slice(0, 10);
      if (dayStr === "2026-11-14") continue; // keep real sample CSV for 2026-11-14
      const lines = [
        "Server Name,Policy Name,Schedule Type,Start Time,End Time,Elapsed Time,Master Server,Media Server,Backup Size,Backup Speed,Job ID,Job Status,Status Code,Schedule Name,Policy Type,Backup Start Date,Backup Size (KB),Elapsed (sec),Backup Speed (KB/sec)",
      ];
      const count = 25 + Math.floor(rand() * 15);
      for (let i = 0; i < count; i++) {
        jid++;
        const startMin = Math.floor(rand() * 420);
        const start = new Date(`${dayStr}T18:00:00Z`);
        start.setUTCMinutes(start.getUTCMinutes() + startMin);
        const el = 300 + Math.floor(rand() * 8700);
        const end = new Date(start.getTime() + el * 1000);
        const r = rand();
        const [label, code] =
          r < 0.89
            ? [OK, 0]
            : r < 0.94
            ? [PARTIAL, 1]
            : [FAILED, failCodes[Math.floor(rand() * failCodes.length)]];
        const kb = label === FAILED ? 0 : 200_000 + Math.floor(rand() * 59_800_000);
        const kbps = kb / el;
        const sp =
          kb === 0
            ? "N/A"
            : kbps >= 1024
            ? `${(kbps / 1024).toFixed(2)} MB/sec`
            : `${kbps.toFixed(2)} KB/sec`;
        const sz =
          kb === 0
            ? "0 KB"
            : kb >= 1048576
            ? `${(kb / 1048576).toFixed(2)} GB`
            : `${(kb / 1024).toFixed(2)} MB`;
        const pad = (n: number) => String(n).padStart(2, "0");
        const fmtDt = (dt: Date) =>
          `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
        const fmtEl = `${pad(Math.floor(el / 3600))}:${pad(Math.floor((el % 3600) / 60))}:${pad(el % 60)}`;
        const srvNum = 1 + Math.floor(rand() * 28);
        const client = `srv${String(srvNum).padStart(2, "0")}.corp.local`;
        const policy = policies[Math.floor(rand() * policies.length)];
        const sched = scheds[Math.floor(rand() * scheds.length)];
        const media = medias[Math.floor(rand() * medias.length)];
        lines.push(
          `${client},${policy},${sched},${fmtDt(start)},${fmtDt(end)},${fmtEl},nbumaster01,${media},${sz},${sp},${jid},${label},${code},sched,Standard,${dayStr},${kb},${el},${kbps.toFixed(2)}`
        );
      }
      this.ingestReport(lines.join("\r\n"), dayStr, "nbumaster01", "seed:demo");
    }

    // Seed storage capacity snapshots
    const todayIso = dateStr(anchor);
    const demoPools: ParsedPool[] = [
      { media_server: "mediasrv01", pool: "DP_ADV_mediasrv01", stype: "AdvancedDisk", total_gb: 20480, used_gb: 13800, free_gb: 6680, used_pct: 67.38, unit_assumed: false },
      { media_server: "mediasrv02", pool: "DP_PD_mediasrv02", stype: "PureDisk", total_gb: 40960, used_gb: 34200, free_gb: 6760, used_pct: 83.5, unit_assumed: false },
      { media_server: "mediasrv03", pool: "DP_ADV_mediasrv03", stype: "AdvancedDisk", total_gb: 16384, used_gb: 15080, free_gb: 1304, used_pct: 92.04, unit_assumed: false },
    ];
    this.ingestStorage(demoPools, todayIso, "nbumaster01", "seed:demo");

    // Seed an initial remark & audit record
    const failedJob = this.jobs.find((j) => j.status === FAILED);
    if (failedJob) {
      const rep = this.reports.get(failedJob.report_id);
      if (rep) {
        this.addRemark({
          master: rep.master,
          report_date: rep.report_date,
          nbu_job_id: failedJob.job_id ?? 0,
          client: failedJob.client,
          policy: failedJob.policy,
          text: "Checked NetBackup media allocation; retrying backup window tonight.",
          created_by: "admin",
        });
      }
    }
    this.audit("system_start", "Portal initialized with in-memory data store", "system", "127.0.0.1");
  }

  getUserByUsername(username: string): User | undefined {
    const target = username.trim().toLowerCase();
    for (const u of this.users.values()) {
      if (u.username.toLowerCase() === target) return u;
    }
    return undefined;
  }

  listUsers(): User[] {
    return Array.from(this.users.values()).sort((a, b) => a.username.localeCompare(b.username));
  }

  createUser(username: string, fullName: string, email: string, role: Role, password: string): User {
    if (this.getUserByUsername(username)) {
      throw new Error("That username already exists.");
    }
    const id = this.seq.user++;
    const user: User = {
      id,
      username,
      full_name: fullName,
      email,
      role,
      pw_hash: bcrypt.hashSync(password, 10),
      active: true,
      failed_count: 0,
      locked_until: null,
      created_at: nowStr(),
      last_login: null,
    };
    this.users.set(id, user);
    return user;
  }

  audit(action: string, detail = "", username: string | null = null, ip: string | null = null) {
    this.auditLog.unshift({
      id: this.seq.audit++,
      ts: nowStr(),
      username,
      action,
      detail: detail.slice(0, 500),
      ip,
    });
    if (this.auditLog.length > 2000) {
      this.auditLog.length = 2000;
    }
  }

  ingestReport(rawBytes: Buffer | string, reportDate: string, masterHint: string, source: string) {
    const date = validateDateOrThrow(reportDate, "report date");
    const { text, rows } = parseReportCsv(rawBytes);

    const counts = new Map<string, number>();
    for (const r of rows) {
      if (r.master && r.master !== "N/A") {
        counts.set(r.master, (counts.get(r.master) || 0) + 1);
      }
    }
    let topMaster = "";
    let topCount = 0;
    for (const [m, c] of counts.entries()) {
      if (c > topCount) {
        topMaster = m;
        topCount = c;
      }
    }
    const master = (topMaster || (masterHint || "").trim()) || "unknown";
    if (!isValidMasterName(master)) {
      throw new IngestError("invalid master server name");
    }

    // Replace existing report for same master + date
    for (const [id, rep] of this.reports.entries()) {
      if (rep.master === master && rep.report_date === date) {
        this.reports.delete(id);
        this.jobs = this.jobs.filter((j) => j.report_id !== id);
      }
    }

    const rid = this.seq.report++;
    this.reports.set(rid, {
      id: rid,
      master,
      report_date: date,
      ingested_at: nowStr(),
      source,
      row_count: rows.length,
      raw_csv: text,
    });

    for (const r of rows) {
      this.jobs.push({
        id: this.seq.job++,
        report_id: rid,
        ...r,
      });
    }

    return { rid, master, date, count: rows.length };
  }

  deleteReport(rid: number): Report | null {
    const rep = this.reports.get(rid) || null;
    if (!rep) return null;
    this.reports.delete(rid);
    this.jobs = this.jobs.filter((j) => j.report_id !== rid);
    return rep;
  }

  ingestStorage(pools: ParsedPool[], snapshotDate: string, masterInput: string, source: string) {
    const date = validateDateOrThrow(snapshotDate, "snapshot date");
    const master = (masterInput || "").trim();
    if (!isValidMasterName(master)) {
      throw new IngestError("a valid primary server name (X-Master) is required");
    }
    if (!pools.length) {
      throw new IngestError("no storage pools supplied");
    }
    const ts = nowStr();
    for (const p of pools) {
      this.storageSnapshots = this.storageSnapshots.filter(
        (s) => !(s.master === master && s.snapshot_date === date && s.media_server === p.media_server && s.pool === p.pool)
      );
      this.storageSnapshots.push({
        id: this.seq.storage++,
        master,
        snapshot_date: date,
        media_server: p.media_server.slice(0, 120),
        pool: p.pool.slice(0, 120),
        stype: (p.stype || "").slice(0, 60),
        total_gb: p.total_gb,
        used_gb: p.used_gb,
        free_gb: p.free_gb,
        used_pct: p.used_pct,
        unit_assumed: Boolean(p.unit_assumed),
        source,
        ingested_at: ts,
      });
    }
    return { count: pools.length, date, master };
  }

  getMasters(): string[] {
    const set = new Set<string>();
    for (const r of this.reports.values()) set.add(r.master);
    for (const s of this.storageSnapshots) set.add(s.master);
    return Array.from(set).sort();
  }

  pickReport(masterArg?: string, dateArg?: string): { masters: string[]; master: string; rep: Report | null } {
    const masters = this.getMasters();
    const master = masterArg || masters[0] || "";
    const date = validDate(dateArg);
    const matching = Array.from(this.reports.values()).filter((r) => r.master === master);
    let rep: Report | null = null;
    if (date) {
      rep = matching.find((r) => r.report_date === date) || null;
    } else {
      matching.sort((a, b) => b.report_date.localeCompare(a.report_date));
      rep = matching[0] || null;
    }
    return { masters, master, rep };
  }

  summarize(reportId: number): SummaryStats {
    const rows = this.jobs.filter((j) => j.report_id === reportId);
    const s: SummaryStats = {
      total: 0,
      successful: 0,
      partial: 0,
      failed: 0,
      running: 0,
      incomplete: 0,
      total_data: "0 KB",
      avg_speed: "N/A",
      success_pct: null,
    };
    let kbSum = 0;
    let spdKb = 0;
    let spdSec = 0;
    for (const r of rows) {
      s.total++;
      if (r.status === OK) s.successful++;
      else if (r.status === PARTIAL) s.partial++;
      else if (r.status === FAILED) s.failed++;
      else if (r.status === RUNNING) s.running++;
      else s.incomplete++;
      kbSum += r.size_kb || 0;
      if (r.size_kb > 0 && r.elapsed_sec && r.elapsed_sec > 0) {
        spdKb += r.size_kb;
        spdSec += r.elapsed_sec;
      }
    }
    s.total_data = fmtSize(kbSum);
    s.avg_speed = spdSec > 0 ? fmtSpeed(spdKb / spdSec) : "N/A";
    const finished = s.successful + s.partial + s.failed + s.incomplete;
    s.success_pct = finished > 0 ? (100.0 * s.successful) / finished : null;
    return s;
  }

  rangeKpis(master: string, firstDay: string, lastDay: string, daysExpected: number): RangeKpis {
    const reps = Array.from(this.reports.values()).filter(
      (r) => r.master === master && r.report_date >= firstDay && r.report_date <= lastDay
    );
    const repIds = new Set(reps.map((r) => r.id));
    let total = 0,
      successful = 0,
      partial = 0,
      failed = 0,
      incomplete = 0,
      kb = 0,
      skb = 0,
      ssec = 0;
    for (const j of this.jobs) {
      if (!repIds.has(j.report_id)) continue;
      total++;
      if (j.status === OK) successful++;
      else if (j.status === PARTIAL) partial++;
      else if (j.status === FAILED) failed++;
      else if (j.status !== RUNNING) incomplete++;
      kb += j.size_kb || 0;
      if (j.size_kb > 0 && j.elapsed_sec && j.elapsed_sec > 0) {
        skb += j.size_kb;
        ssec += j.elapsed_sec;
      }
    }
    const finished = successful + partial + failed + incomplete;
    return {
      total,
      successful,
      partial,
      failed,
      incomplete,
      kb,
      avg_kbps: ssec > 0 ? skb / ssec : null,
      success_pct: finished > 0 ? (100.0 * successful) / finished : null,
      days_reported: new Set(reps.map((r) => r.report_date)).size,
      days_expected: daysExpected,
    };
  }

  addRemark(input: {
    master: string;
    report_date: string;
    nbu_job_id: number;
    client: string;
    policy: string;
    text: string;
    created_by: string;
    source?: string;
  }): Remark {
    const rem: Remark = {
      id: this.seq.remark++,
      master: input.master,
      report_date: input.report_date,
      nbu_job_id: input.nbu_job_id,
      client: input.client.slice(0, 200),
      policy: input.policy.slice(0, 200),
      text: input.text,
      status: "Open",
      created_by: input.created_by,
      created_at: nowStr(),
      resolved_by: null,
      resolved_at: null,
      source: input.source || "portal",
    };
    this.remarks.push(rem);
    return rem;
  }

  resolveRemark(id: number, username: string): boolean {
    const rem = this.remarks.find((r) => r.id === id);
    if (!rem) return false;
    rem.status = "Resolved";
    rem.resolved_by = username;
    rem.resolved_at = nowStr();
    return true;
  }

  private sessionSecret: string = "";
  private flashMap: Map<string, FlashMsg[]> = new Map();

  getSessionSecret(): string {
    if (this.sessionSecret) return this.sessionSecret;
    const envKey = (process.env.SECRET_KEY || "").trim();
    if (envKey) {
      this.sessionSecret = envKey;
      return envKey;
    }
    const keyFile = path.join(os.tmpdir(), "mbop_secret_key");
    try {
      if (fs.existsSync(keyFile)) {
        const stored = fs.readFileSync(keyFile, "utf-8").trim();
        if (stored) {
          this.sessionSecret = stored;
          return stored;
        }
      }
      const generated = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(keyFile, generated, { mode: 0o600 });
      this.sessionSecret = generated;
      return generated;
    } catch {
      this.sessionSecret = crypto.randomBytes(32).toString("hex");
      return this.sessionSecret;
    }
  }

  encodeSessionCookie(data: SessionData): string {
    const payload = Buffer.from(
      JSON.stringify({ id: data.id, uid: data.uid, csrf: data.csrf, exp: data.expiresAt }),
      "utf-8"
    ).toString("base64url");
    const sig = crypto.createHmac("sha256", this.getSessionSecret()).update(payload).digest("base64url");
    return `${payload}.${sig}`;
  }

  decodeSessionCookie(raw: string | undefined): SessionData | null {
    if (!raw || !raw.includes(".")) return null;
    const [payload, sig] = raw.split(".", 2);
    if (!payload || !sig) return null;
    const expected = crypto.createHmac("sha256", this.getSessionSecret()).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as {
        id: string;
        uid: number | null;
        csrf: string;
        exp: number;
      };
      if (!parsed.id || !parsed.csrf || !parsed.exp || parsed.exp <= Date.now()) {
        return null;
      }
      let flashes = this.flashMap.get(parsed.id);
      if (!flashes) {
        flashes = [];
        this.flashMap.set(parsed.id, flashes);
      }
      return {
        id: parsed.id,
        uid: parsed.uid ?? null,
        csrf: parsed.csrf,
        flashes,
        expiresAt: parsed.exp,
      };
    } catch {
      return null;
    }
  }

  getOrCreateSession(rawCookie: string | undefined, sessionHours: number): { data: SessionData; isNew: boolean } {
    const decoded = this.decodeSessionCookie(rawCookie);
    if (decoded) {
      return { data: decoded, isNew: false };
    }
    const id = crypto.randomBytes(18).toString("hex");
    const flashes: FlashMsg[] = [];
    this.flashMap.set(id, flashes);
    const data: SessionData = {
      id,
      uid: null,
      csrf: crypto.randomBytes(16).toString("hex"),
      flashes,
      expiresAt: Date.now() + sessionHours * 3600_000,
    };
    return { data, isNew: true };
  }
}

export const store = new MemoryStore();
