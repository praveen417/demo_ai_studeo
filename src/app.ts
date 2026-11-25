import path from "node:path";
import crypto from "node:crypto";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import multer from "multer";
import {
  capacitySvg,
  donutSvg,
  FAIL,
  INC,
  MediaOutcomeRow,
  OK as CHART_OK,
  outcomesByMediaSvg,
  rateSvg,
  RUN,
  TrendPoint,
  trendSvg,
  WARN,
} from "./charts.js";
import { escapeHtml, fmtSize, nowStr, toInt, validDate } from "./fmt.js";
import { IngestError, parseNbdevquery } from "./ingest.js";
import {
  FAILED,
  LOCK_MINUTES,
  MAX_FAILS,
  OK,
  PAGE_SIZE,
  PARTIAL,
  PERMS,
  Role,
  ROLES,
  RUNNING,
  SessionData,
  store,
  User,
} from "./store.js";

const SESSION_HOURS = Math.max(1, Number(process.env.SESSION_HOURS || "8") || 8);
const MAX_UPLOAD_MB = Math.max(1, Number(process.env.MAX_UPLOAD_MB || "20") || 20);
const KPI_SUCCESS_TARGET = Number(process.env.KPI_SUCCESS_TARGET || "98") || 98;
const STORAGE_WARN_PCT = Number(process.env.STORAGE_WARN_PCT || "80") || 80;
const STORAGE_CRIT_PCT = Number(process.env.STORAGE_CRIT_PCT || "90") || 90;
const NAV_SIDE = process.env.NAV_SIDE === "left" ? "left" : "right";
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

declare global {
  namespace Express {
    interface Request {
      sess?: SessionData;
      user?: User | null;
    }
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function csvCell(val: unknown): string {
  const s = String(val ?? "");
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(r.map(csvCell).join(","));
  }
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}

function flash(req: Request, cat: "ok" | "error" | "warn", text: string) {
  req.sess?.flashes.push({ cat, text });
}

function can(user: User | null | undefined, perm: string): boolean {
  if (!user) return false;
  const allowed = PERMS[perm];
  return Boolean(allowed && allowed.has(user.role));
}

function requirePerm(perm: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!can(req.user, perm)) {
      return res.status(403).render("error", {
        code: 403,
        message: "Your role does not permit this action.",
      });
    }
    return next();
  };
}

function apiAuthorized(req: Request): boolean {
  if (!INGEST_TOKEN) {
    store.audit("api_denied", `${req.path} rejected`, "api", req.ip || null);
    return false;
  }
  const auth = req.get("Authorization") || "";
  const ok = auth.startsWith("Bearer ") && timingSafeEqualStr(auth.slice(7), INGEST_TOKEN);
  if (!ok) {
    store.audit("api_denied", `${req.path} rejected`, "api", req.ip || null);
  }
  return ok;
}

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "views"));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  });

  app.use(cookieParser());
  app.use(express.urlencoded({ extended: false, limit: `${MAX_UPLOAD_MB}mb` }));
  app.use(express.json({ limit: `${MAX_UPLOAD_MB}mb` }));
  app.use(express.text({ type: ["text/*", "application/octet-stream"], limit: `${MAX_UPLOAD_MB}mb` }));

  // Security headers (iframe-compatible for AI Studio preview)
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // Static files
  const staticDir = path.join(process.cwd(), "public", "static");
  app.use("/static", express.static(staticDir));

  // PWA & Health (before auth)
  app.get("/manifest.webmanifest", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.type("application/manifest+json").sendFile(path.join(staticDir, "manifest.webmanifest"));
  });

  app.get("/sw.js", (_req, res) => {
    res.setHeader("Service-Worker-Allowed", "/");
    res.setHeader("Cache-Control", "no-cache");
    res.type("application/javascript").sendFile(path.join(staticDir, "sw.js"));
  });

  app.get("/offline", (_req, res) => {
    res.render("offline");
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  function getCookieOpts(req: Request): express.CookieOptions {
    const proto = String(req.get("x-forwarded-proto") || "");
    const forwarded = String(req.get("forwarded") || "");
    const origin = String(req.get("origin") || "");
    const referer = String(req.get("referer") || "");
    const host = String(req.get("host") || "");
    const secDest = String(req.get("sec-fetch-dest") || "");
    const secSite = String(req.get("sec-fetch-site") || "");
    const isHttps =
      process.env.COOKIE_SECURE === "1" ||
      req.secure ||
      proto.toLowerCase().includes("https") ||
      forwarded.toLowerCase().includes("proto=https") ||
      origin.startsWith("https://") ||
      referer.startsWith("https://") ||
      host.endsWith(".run.app") ||
      secDest === "iframe" ||
      secSite === "cross-site";
    return {
      httpOnly: true,
      sameSite: isHttps ? "none" : "lax",
      secure: isHttps,
      partitioned: isHttps,
      maxAge: SESSION_HOURS * 3600_000,
    } as express.CookieOptions;
  }

  // Session, user loading, locals, and CSRF
  app.use((req, res, next) => {
    const { data, isNew } = store.getOrCreateSession(req.cookies?.mbop_session, SESSION_HOURS);
    req.sess = data;
    if (isNew) {
      res.cookie("mbop_session", store.encodeSessionCookie(data), getCookieOpts(req));
    }

    let user: User | null = null;
    if (data.uid !== null) {
      const found = store.users.get(data.uid);
      if (found && found.active) {
        user = found;
      } else {
        data.uid = null;
      }
    }
    req.user = user;

    res.locals.user = user;
    res.locals.nav_side = NAV_SIDE;
    res.locals.endpoint = "";
    res.locals.can = (perm: string) => can(user, perm);
    res.locals.fmtSize = fmtSize;
    res.locals.csrfInput = () => `<input type="hidden" name="csrf" value="${escapeHtml(data.csrf)}">`;
    res.locals.badge = (status: string) => {
      const cls = String(status || "").split(" ")[0];
      return `<span class="badge b-${escapeHtml(cls)}">${escapeHtml(status)}</span>`;
    };
    res.locals.qs = (obj: Record<string, string>) => {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined && v !== "") sp.set(k, v);
      }
      return sp.toString();
    };
    res.locals.consumeFlashes = () => data.flashes.splice(0, data.flashes.length);
    next();
  });

  // Auth & CSRF guard
  app.use((req, res, next) => {
    const p = req.path;
    if (p.startsWith("/api/") || p === "/login" || p === "/health" || p === "/offline" || p === "/manifest.webmanifest" || p === "/sw.js" || p.startsWith("/static/")) {
      return next();
    }
    if (!req.user) {
      const nextUrl = req.originalUrl && /^\/[^/\\]/.test(req.originalUrl) ? `?next=${encodeURIComponent(req.originalUrl)}` : "";
      return res.redirect(`/login${nextUrl}`);
    }
    if (req.user.role === "Requester" && !["/requests", "/approvals", "/account/password", "/logout"].some((x) => p.startsWith(x))) {
      return res.redirect("/requests");
    }
    if (req.method === "POST" && !req.is("multipart/form-data")) {
      const sent = String(req.body?.csrf || "");
      if (!timingSafeEqualStr(sent, req.sess?.csrf || "x")) {
        return res.status(400).render("error", { code: 400, message: "Invalid or missing CSRF token" });
      }
    }
    return next();
  });

  // ------------------------------------------------------------------ auth
  app.get("/login", (req, res) => {
    res.locals.endpoint = "login";
    res.render("login");
  });

  app.post("/login", (req, res) => {
    res.locals.endpoint = "login";
    const sent = String(req.body?.csrf || "");
    if (!timingSafeEqualStr(sent, req.sess?.csrf || "x")) {
      if (req.sess) {
        res.cookie("mbop_session", store.encodeSessionCookie(req.sess), getCookieOpts(req));
      }
      const msg = req.cookies?.mbop_session
        ? "Your login session was refreshed. Please sign in again."
        : "Session cookie was not sent by your browser. Please allow cookies (or open the app in a new tab) and try again.";
      flash(req, "error", msg);
      return res.status(400).render("login");
    }
    const name = String(req.body?.username || "").trim();
    const pw = String(req.body?.password || "");
    const u = store.getUserByUsername(name);
    const now = nowStr();
    const locked = Boolean(u && u.locked_until && u.locked_until > now);

    if (u && u.active && !locked && bcrypt.compareSync(pw, u.pw_hash)) {
      u.failed_count = 0;
      u.locked_until = null;
      u.last_login = now;
      if (req.sess) {
        req.sess.uid = u.id;
        req.sess.csrf = crypto.randomBytes(16).toString("hex");
        res.cookie("mbop_session", store.encodeSessionCookie(req.sess), getCookieOpts(req));
      }
      store.audit("login", "", u.username, req.ip || null);
      const nxt = String(req.query.next || "");
      return res.redirect(/^\/[^/\\]/.test(nxt) ? nxt : "/");
    }

    if (u && !locked) {
      const fails = u.failed_count + 1;
      if (fails >= MAX_FAILS) {
        const until = nowStr(new Date(Date.now() + LOCK_MINUTES * 60_000));
        u.failed_count = 0;
        u.locked_until = until;
      } else {
        u.failed_count = fails;
      }
    }
    store.audit("login_failed", `user=${name.slice(0, 60)}${locked ? " (locked)" : ""}`, name.slice(0, 60) || null, req.ip || null);
    flash(req, "error", "Invalid credentials, or the account is temporarily locked.");
    return res.render("login");
  });

  app.post("/logout", (req, res) => {
    store.audit("logout", "", req.user?.username || null, req.ip || null);
    const opts = getCookieOpts(req);
    delete opts.maxAge;
    res.clearCookie("mbop_session", opts);
    return res.redirect("/login");
  });

  app.get("/account/password", (req, res) => {
    res.locals.endpoint = "account_password";
    res.render("account");
  });

  app.post("/account/password", (req, res) => {
    res.locals.endpoint = "account_password";
    const u = req.user!;
    const current = String(req.body?.current || "");
    const nextPw = String(req.body?.new || "");
    if (!bcrypt.compareSync(current, u.pw_hash)) {
      flash(req, "error", "Current password is incorrect.");
    } else if (nextPw.length < 10) {
      flash(req, "error", "New password must be at least 10 characters.");
    } else {
      u.pw_hash = bcrypt.hashSync(nextPw, 10);
      store.audit("password_change", "", u.username, req.ip || null);
      flash(req, "ok", "Password changed.");
    }
    res.render("account");
  });

  // ------------------------------------------------------------- dashboard
  app.get("/", (req, res) => {
    if (req.user?.role === "Requester") {
      return res.redirect("/requests");
    }
    res.locals.endpoint = "dashboard";
    const { masters, master, rep } = store.pickReport(
      String(req.query.master || "") || undefined,
      String(req.query.date || "") || undefined
    );

    if (!rep) {
      return res.render("dashboard", {
        masters,
        master,
        rep: null,
        stale: null,
      });
    }

    const s = store.summarize(rep.id);
    const repJobs = store.jobs.filter((j) => j.report_id === rep.id);

    // Media server table aggregation
    const mediaMap = new Map<string, { media: string; jobs: number; kb: number; problems: number; skb: number; ssec: number }>();
    for (const j of repJobs) {
      const m = j.media || "N/A";
      const cur = mediaMap.get(m) || { media: m, jobs: 0, kb: 0, problems: 0, skb: 0, ssec: 0 };
      cur.jobs++;
      cur.kb += j.size_kb || 0;
      if (j.status !== OK && j.status !== RUNNING) cur.problems++;
      if (j.size_kb > 0 && j.elapsed_sec && j.elapsed_sec > 0) {
        cur.skb += j.size_kb;
        cur.ssec += j.elapsed_sec;
      }
      mediaMap.set(m, cur);
    }
    const media = Array.from(mediaMap.values()).sort((a, b) => b.jobs - a.jobs);

    // Problems needing attention
    const problems = repJobs
      .filter((j) => j.status !== OK && j.status !== RUNNING)
      .sort((a, b) => {
        const af = a.status === FAILED ? 0 : 1;
        const bf = b.status === FAILED ? 0 : 1;
        if (af !== bf) return af - bf;
        return a.start_time.localeCompare(b.start_time);
      })
      .slice(0, 15);

    const rng = Math.min(Math.max(toInt(req.query.range, 30) ?? 30, 7), 90);
    const days = Array.from(store.reports.values())
      .filter((r) => r.master === master && r.report_date <= rep.report_date)
      .sort((a, b) => b.report_date.localeCompare(a.report_date))
      .slice(0, rng)
      .reverse();

    const firstDateObj = new Date(`${rep.report_date}T00:00:00Z`);
    firstDateObj.setUTCDate(firstDateObj.getUTCDate() - (rng - 1));
    const firstDay = firstDateObj.toISOString().slice(0, 10);
    const range_k = store.rangeKpis(master, firstDay, rep.report_date, rng);

    const pts: TrendPoint[] = days.map((d) => {
      const st = store.summarize(d.id);
      return {
        date: d.report_date,
        total: st.total,
        successful: st.successful,
        partial: st.partial,
        failed: st.failed,
        other: st.running + st.incomplete,
      };
    });

    const trend = trendSvg(pts);
    const rate_chart = rateSvg(
      pts.map((p) => [p.date, p.total - p.other > 0 ? (100.0 * p.successful) / (p.total - p.other) : null]),
      KPI_SUCCESS_TARGET
    );
    const donut = donutSvg(
      [
        { label: "Successful", value: s.successful, color: CHART_OK },
        { label: "Partially successful", value: s.partial, color: WARN },
        { label: "Failed", value: s.failed, color: FAIL },
        { label: "Incomplete/Queued", value: s.incomplete, color: INC },
        { label: "Running", value: s.running, color: RUN },
      ],
      s.success_pct === null ? "N/A" : `${s.success_pct.toFixed(1)}%`,
      "success rate"
    );

    const aggMap = new Map<string, MediaOutcomeRow>();
    for (const j of repJobs) {
      const m = j.media || "N/A";
      const cur = aggMap.get(m) || { media: m, successful: 0, partial: 0, failed: 0, other: 0, total: 0 };
      if (j.status === OK) cur.successful++;
      else if (j.status === PARTIAL) cur.partial++;
      else if (j.status === FAILED) cur.failed++;
      else cur.other++;
      cur.total++;
      aggMap.set(m, cur);
    }
    const media_chart = outcomesByMediaSvg(Array.from(aggMap.values()).sort((a, b) => b.total - a.total));

    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const allDates = Array.from(store.reports.values())
      .filter((r) => r.master === master)
      .map((r) => r.report_date)
      .sort();
    const latest = allDates[allDates.length - 1] || "";
    const stale = latest && latest < yesterday ? `No report received for ${yesterday} - the latest report is for ${latest}.` : null;

    // Storage capacity per media server (latest snapshot per pool)
    const latestPools = new Map<string, (typeof store.storageSnapshots)[number]>();
    for (const snap of store.storageSnapshots) {
      if (snap.master !== master) continue;
      const key = `${snap.media_server}|${snap.pool}`;
      const existing = latestPools.get(key);
      if (!existing || snap.snapshot_date > existing.snapshot_date) {
        latestPools.set(key, snap);
      }
    }
    const capMap = new Map<string, { media: string; total_gb: number; used_gb: number; free_gb: number; pools: number }>();
    let cap_date: string | null = null;
    for (const snap of latestPools.values()) {
      const cur = capMap.get(snap.media_server) || { media: snap.media_server, total_gb: 0, used_gb: 0, free_gb: 0, pools: 0 };
      cur.total_gb += snap.total_gb;
      cur.used_gb += snap.used_gb;
      cur.free_gb += snap.free_gb;
      cur.pools++;
      capMap.set(snap.media_server, cur);
      if (!cap_date || snap.snapshot_date > cap_date) cap_date = snap.snapshot_date;
    }
    const cap_rows = Array.from(capMap.values())
      .map((c) => {
        const used_pct = c.total_gb > 0 ? (100.0 * c.used_gb) / c.total_gb : 0;
        const status = used_pct >= STORAGE_CRIT_PCT ? "Critical" : used_pct >= STORAGE_WARN_PCT ? "Warning" : "OK";
        return { ...c, used_pct, status };
      })
      .sort((a, b) => b.used_pct - a.used_pct);

    return res.render("dashboard", {
      masters,
      master,
      rep,
      stale,
      s,
      media,
      problems,
      range_days: rng,
      range_k,
      trend,
      rate_chart,
      donut,
      media_chart,
      cap_rows,
      cap_chart: capacitySvg(cap_rows, STORAGE_WARN_PCT, STORAGE_CRIT_PCT),
      cap_date,
      warn: STORAGE_WARN_PCT,
      crit: STORAGE_CRIT_PCT,
    });
  });

  // ------------------------------------------------------------------ jobs
  app.get("/jobs", (req, res) => {
    res.locals.endpoint = "jobs";
    const { masters, master, rep } = store.pickReport(
      String(req.query.master || "") || undefined,
      String(req.query.date || "") || undefined
    );
    if (!rep) {
      return res.render("jobs", { masters, master, rep: null });
    }
    const q = String(req.query.q || "").trim().toLowerCase();
    const statusF = String(req.query.status || "").trim();
    const mediaF = String(req.query.media || "").trim();
    const schedF = String(req.query.schedule || "").trim();

    const repJobs = store.jobs.filter((j) => j.report_id === rep.id);
    const filtered = repJobs
      .filter((j) => {
        if (q) {
          const hit =
            j.client.toLowerCase().includes(q) ||
            j.policy.toLowerCase().includes(q) ||
            String(j.job_id ?? "") === q ||
            j.media.toLowerCase().includes(q);
          if (!hit) return false;
        }
        if (statusF && j.status !== statusF) return false;
        if (mediaF && j.media !== mediaF) return false;
        if (schedF && j.schedule_type !== schedF) return false;
        return true;
      })
      .sort((a, b) => a.start_time.localeCompare(b.start_time));

    if (req.query.format === "csv") {
      const headers = [
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
      const csvRows = filtered.map((r) => [
        r.client,
        r.policy,
        r.schedule_type,
        r.start_time,
        r.end_time,
        r.elapsed_txt,
        r.master,
        r.media,
        r.size_txt,
        r.speed_txt,
        r.job_id,
        r.status,
        r.status_code,
      ]);
      store.audit("export_jobs", `${rep.master} ${rep.report_date} (${filtered.length} rows)`, req.user?.username || null, req.ip || null);
      res.setHeader("Content-Disposition", `attachment; filename=jobs_${rep.report_date}.csv`);
      return res.type("text/csv").send(toCsv(headers, csvRows));
    }

    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(pages, Math.max(1, toInt(req.query.page, 1) ?? 1));
    const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    const opts = {
      statuses: Array.from(new Set(repJobs.map((j) => j.status))).sort(),
      medias: Array.from(new Set(repJobs.map((j) => j.media))).sort(),
      schedules: Array.from(new Set(repJobs.map((j) => j.schedule_type))).sort(),
    };

    const qargs: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (k !== "page" && k !== "format" && typeof v === "string" && v) {
        qargs[k] = v;
      }
    }

    return res.render("jobs", {
      masters,
      master,
      rep,
      rows,
      total,
      page,
      pages,
      opts,
      args: req.query,
      qargs,
    });
  });

  // -------------------------------------------------------------- failures
  app.get("/failures", (req, res) => {
    res.locals.endpoint = "failures";
    const days = Math.min(Math.max(toInt(req.query.days, 7) ?? 7, 1), 90);
    const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

    const rows = store.jobs
      .map((j) => {
        const rep = store.reports.get(j.report_id);
        return rep ? { ...j, report_date: rep.report_date, rmaster: rep.master } : null;
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .filter((j) => j.report_date >= since && j.status !== OK && j.status !== RUNNING)
      .sort((a, b) => {
        if (a.report_date !== b.report_date) return b.report_date.localeCompare(a.report_date);
        const af = a.status === FAILED ? 0 : 1;
        const bf = b.status === FAILED ? 0 : 1;
        if (af !== bf) return af - bf;
        return a.start_time.localeCompare(b.start_time);
      });

    const remarks = new Map<string, typeof store.remarks>();
    for (const rm of store.remarks) {
      if (rm.report_date < since) continue;
      const key = `${rm.master}|${rm.report_date}|${rm.nbu_job_id}`;
      const list = remarks.get(key) || [];
      list.push(rm);
      remarks.set(key, list);
    }

    res.render("failures", { rows, remarks, days });
  });

  app.post("/remarks", requirePerm("remark"), (req, res) => {
    const master = String(req.body?.master || "");
    const date = validDate(String(req.body?.date || ""));
    const jid = toInt(req.body?.job_id);
    const text = String(req.body?.text || "").trim();
    if (!master || !date || jid === null || text.length < 3 || text.length > 1000) {
      return res.status(400).render("error", { code: 400, message: "A remark of 3-1000 characters is required" });
    }
    store.addRemark({
      master,
      report_date: date,
      nbu_job_id: jid,
      client: String(req.body?.client || ""),
      policy: String(req.body?.policy || ""),
      text,
      created_by: req.user!.username,
    });
    store.audit("remark_add", `${master} ${date} job ${jid}`, req.user!.username, req.ip || null);
    return res.redirect(req.get("Referer") || "/failures");
  });

  app.post("/remarks/:rid/resolve", requirePerm("resolve"), (req, res) => {
    const rid = toInt(req.params.rid);
    if (rid !== null && store.resolveRemark(rid, req.user!.username)) {
      store.audit("remark_resolve", `remark ${rid}`, req.user!.username, req.ip || null);
    }
    return res.redirect(req.get("Referer") || "/failures");
  });

  // --------------------------------------------------------------- reports
  app.get("/reports", (_req, res) => {
    res.locals.endpoint = "reports";
    const rows = Array.from(store.reports.values())
      .sort((a, b) => b.report_date.localeCompare(a.report_date) || a.master.localeCompare(b.master))
      .slice(0, 400);
    res.render("reports", { rows });
  });

  app.get("/reports/:rid/csv", (req, res) => {
    const rid = toInt(req.params.rid);
    const rep = rid !== null ? store.reports.get(rid) : undefined;
    if (!rep) {
      return res.status(404).render("error", { code: 404, message: "Not found." });
    }
    store.audit("download_report", `${rep.master} ${rep.report_date}`, req.user?.username || null, req.ip || null);
    res.setHeader("Content-Disposition", `attachment; filename=NetBackup_Daily_Report_${rep.report_date.replace(/-/g, "")}.csv`);
    return res.type("text/csv").send("\ufeff" + rep.raw_csv);
  });

  app.post("/reports/:rid/delete", requirePerm("delete_report"), (req, res) => {
    const rid = toInt(req.params.rid);
    const rep = rid !== null ? store.deleteReport(rid) : null;
    if (!rep) {
      return res.status(404).render("error", { code: 404, message: "Not found." });
    }
    store.audit("report_delete", `${rep.master} ${rep.report_date}`, req.user!.username, req.ip || null);
    return res.redirect("/reports");
  });

  // ---------------------------------------------------------------- upload
  app.get("/upload", requirePerm("upload"), (_req, res) => {
    res.locals.endpoint = "upload";
    res.render("upload");
  });

  app.post("/upload", requirePerm("upload"), upload.single("file"), (req, res) => {
    res.locals.endpoint = "upload";
    const sent = String(req.body?.csrf || "");
    if (!timingSafeEqualStr(sent, req.sess?.csrf || "x")) {
      return res.status(400).render("error", { code: 400, message: "Invalid or missing CSRF token" });
    }
    if (!req.file) {
      flash(req, "error", "Choose a CSV file.");
      return res.render("upload");
    }
    try {
      const result = store.ingestReport(
        req.file.buffer,
        String(req.body?.date || ""),
        String(req.body?.master || ""),
        `upload:${req.user!.username}`
      );
      store.audit("upload_report", `${result.master} ${result.date} (${result.count} jobs)`, req.user!.username, req.ip || null);
      flash(req, "ok", `Report for ${result.date} (${result.master}) imported: ${result.count} job(s).`);
      return res.redirect(`/?master=${encodeURIComponent(result.master)}&date=${encodeURIComponent(result.date)}`);
    } catch (err) {
      flash(req, "error", (err as Error).message);
      return res.render("upload");
    }
  });

  app.post("/upload/storage", requirePerm("upload"), (req, res) => {
    const raw = String(req.body?.text || "");
    const date = String(req.body?.date || "");
    const master = String(req.body?.master || "").trim();
    try {
      const pools = parseNbdevquery(raw);
      const result = store.ingestStorage(pools, date, master, `upload:${req.user!.username}`);
      store.audit("upload_storage", `${result.master} ${result.date} (${result.count} pools)`, req.user!.username, req.ip || null);
      flash(req, "ok", `Storage snapshot for ${result.date} imported: ${result.count} pool(s).`);
    } catch (err) {
      flash(req, "error", (err as Error).message);
    }
    return res.redirect("/upload");
  });

  // ------------------------------------------------------------------- API
  app.post("/api/v1/reports", (req, res) => {
    if (!apiAuthorized(req)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    try {
      const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body || "");
      const result = store.ingestReport(
        rawBody,
        req.get("X-Report-Date") || "",
        req.get("X-Master") || "",
        `api:${req.ip}`
      );
      store.audit("api_ingest", `${result.master} ${result.date} (${result.count} jobs)`, "api", req.ip || null);
      return res.json({
        status: "ok",
        report_id: result.rid,
        master: result.master,
        report_date: result.date,
        jobs: result.count,
      });
    } catch (err) {
      const msg = (err as Error).message;
      const status = err instanceof IngestError ? err.status : 400;
      store.audit("api_rejected", msg, "api", req.ip || null);
      return res.status(status).json({ error: msg });
    }
  });

  app.post("/api/v1/storage", (req, res) => {
    if (!apiAuthorized(req)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const data = (req.body || {}) as Record<string, unknown>;
    try {
      const rawPools = Array.isArray(data.pools) ? data.pools : [];
      const pools = rawPools.map((p: Record<string, unknown>) => {
        const total = Number(p.total_gb);
        const free = Number(p.free_gb);
        if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free) || free < 0 || free > total) {
          throw new IngestError(`invalid capacity for pool ${String(p.pool || "")}`);
        }
        const used = total - free;
        return {
          media_server: String(p.media_server || ""),
          pool: String(p.pool || ""),
          stype: String(p.stype || ""),
          total_gb: Math.round(total * 100) / 100,
          free_gb: Math.round(free * 100) / 100,
          used_gb: Math.round(used * 100) / 100,
          used_pct: Math.round((100.0 * used / total) * 100) / 100,
          unit_assumed: false,
        };
      });
      const result = store.ingestStorage(
        pools,
        String(data.snapshot_date || ""),
        String(data.master || ""),
        `api:${req.ip}`
      );
      store.audit("api_storage", `${result.master} ${result.date} (${result.count} pools, json)`, "api", req.ip || null);
      return res.json({ status: "ok", master: result.master, snapshot_date: result.date, pools: result.count });
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
  });

  // ----------------------------------------------------------------- admin
  app.get("/audit", requirePerm("audit"), (_req, res) => {
    res.locals.endpoint = "audit_log";
    res.render("audit", { rows: store.auditLog.slice(0, 500) });
  });

  app.get("/admin/users", requirePerm("users"), (_req, res) => {
    res.locals.endpoint = "users";
    res.render("users", { rows: store.listUsers(), roles: ROLES, now: nowStr() });
  });

  app.post("/admin/users", requirePerm("users"), (req, res) => {
    const act = String(req.body?.action || "");
    const uid = toInt(req.body?.id);
    if (act === "create") {
      const name = String(req.body?.username || "").trim();
      const pw = String(req.body?.password || "");
      const role = String(req.body?.role || "") as Role;
      const mail = String(req.body?.email || "").trim();
      if (mail && !EMAIL_RE.test(mail)) {
        flash(req, "error", "Enter a valid e-mail address (or leave it empty).");
        return res.redirect("/admin/users");
      }
      if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(name) || !ROLES.includes(role) || pw.length < 10) {
        flash(req, "error", "Username 3-64 chars (letters, digits, _ . @ -), a valid role and a password of at least 10 characters are required.");
      } else {
        try {
          store.createUser(name, String(req.body?.full_name || "").trim().slice(0, 100), mail, role, pw);
          store.audit("user_create", `${name} (${role})`, req.user!.username, req.ip || null);
          flash(req, "ok", `User ${name} created.`);
        } catch (err) {
          flash(req, "error", (err as Error).message);
        }
      }
    } else if (act === "email" && uid !== null) {
      const target = store.users.get(uid);
      const mail = String(req.body?.email || "").trim();
      if (!target) {
        return res.status(404).render("error", { code: 404, message: "Not found." });
      }
      if (mail && !EMAIL_RE.test(mail)) {
        flash(req, "error", "Enter a valid e-mail address.");
      } else {
        target.email = mail;
        store.audit("user_email", `user ${uid}`, req.user!.username, req.ip || null);
      }
    } else if ((act === "role" || act === "toggle" || act === "password") && uid !== null) {
      const target = store.users.get(uid);
      if (!target) {
        return res.status(404).render("error", { code: 404, message: "Not found." });
      }
      if (act === "role") {
        const nextRole = String(req.body?.role || "") as Role;
        if (ROLES.includes(nextRole)) {
          if (target.id === req.user!.id && nextRole !== "Administrator") {
            flash(req, "error", "You cannot remove your own administrator role.");
          } else {
            target.role = nextRole;
            store.audit("user_role", `${target.username} -> ${nextRole}`, req.user!.username, req.ip || null);
          }
        }
      } else if (act === "toggle") {
        if (target.id === req.user!.id) {
          flash(req, "error", "You cannot deactivate yourself.");
        } else {
          target.active = !target.active;
          target.failed_count = 0;
          target.locked_until = null;
          store.audit("user_toggle", target.username, req.user!.username, req.ip || null);
        }
      } else if (act === "password") {
        const pw = String(req.body?.password || "");
        if (pw.length < 10) {
          flash(req, "error", "Password must be at least 10 characters.");
        } else {
          target.pw_hash = bcrypt.hashSync(pw, 10);
          target.failed_count = 0;
          target.locked_until = null;
          store.audit("user_password_reset", target.username, req.user!.username, req.ip || null);
          flash(req, "ok", "Password updated.");
        }
      }
    }
    return res.redirect("/admin/users");
  });

  // -------------------------------------- stubbed secondary routes (501)
  const stubbedPrefixes = [
    "/weekly",
    "/monthly",
    "/mail",
    "/storage",
    "/tapes",
    "/policies",
    "/requests",
    "/approvals",
    "/approve",
    "/api/v1/storage/raw",
    "/api/v1/policies",
    "/api/v1/tapes",
    "/api/v1/whatsapp",
    "/api/v1/followup",
  ];
  for (const prefix of stubbedPrefixes) {
    app.use(prefix, (_req, res) => {
      res.status(501).json({ error: "Not yet migrated" });
    });
  }

  // -------------------------------------------------------- error handlers
  app.use((_req, res) => {
    res.status(404).render("error", { code: 404, message: "Not found." });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[MBOP] Unhandled error:", err);
    res.status(500).render("error", { code: 500, message: err.message || "Internal server error" });
  });

  return app;
}
