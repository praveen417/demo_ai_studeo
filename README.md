# MBOP Backup Reports - portal module

Web portal that receives the daily NetBackup report from the report script and shows it to the team.

```
NetBackup primary server                      Docker host
 netbackup_daily_report (.sh / .ps1)  --HTTPS POST CSV-->  MBOP portal (Flask + SQLite)
   writes CSV/HTML/log locally                              dashboard, jobs, failures, audit
```

## Features
- **Login with roles** - Administrator, Backup Engineer, Team Lead, Management.
- **Executive dashboard** - KPI cards, success/failure bar, 14-day outcome chart, per-media-server table, jobs needing attention, banner when yesterday's report has not arrived.
- **Backup Jobs** - every job of a day with search and filters (status, media server, schedule type), paging, CSV export.
- **Failures & follow-up** - failed/partial/incomplete jobs for the last 1-90 days; engineers add remarks, Team Leads/Administrators resolve them.
- **Monthly KPI & storage report** - month selector, KPI cards with change vs previous month and success-rate target, daily outcome chart, per-media-server performance, top failing servers/status codes, data by schedule type, and media-server storage (capacity, used %, growth in the month, projected days to full, Warning/Critical status, used-% trend). Export CSV, Print / Save as PDF.
- **Backup Policies** - policy list (type, state, storage unit, media servers used, clients, schedules, last backup job; active policies with no job for 7 days are highlighted), policy detail (backup selection, schedules with type/retention/frequency or calendar/backup window, clients with H/W-OS, editable **Location**, last full-backup size and last result) and an **inventory CSV** with the columns: Policy Name, Policy Type, State, Storage Unit, H/W OS Client, OS, Client, Location, Storage, Backup Selection, Schedule Name, Schedule Type, Retention, Frequency / Calendar, Backup Window, Size (one row per policy x client x schedule).
- **Excel / CSV policy import** - *Policies -> Import Excel / CSV*: upload an `.xlsx` (first sheet) or CSV with the columns Policy Name, Policy Type, State, Storage Unit, H/W OS Client, OS, Client, Location, Storage, Backup Selection, Schedule Name, Schedule Type, Retention, Frequency / Calendar, Backup Window, Size, Application Owner, MTN Application Owner, Domain (one row per policy / client / schedule; only Policy Name is required; title rows above the header are skipped). Rows are grouped into policies, clients, backup selections and schedules; Location, Size, Application Owner, MTN Application Owner and Domain are stored per client. Policies that already came from NetBackup keep their definition by default and only receive the owner/domain/size/location data (or choose *overwrite*). Row-level validation with a line-numbered error list; Excel template download; **Export Excel** / CSV of the whole inventory in the same column layout (so it can be edited and re-imported). A later `bppllist` sync replaces NetBackup-sourced policies but keeps Excel-only policies and all owner/domain data. Per-client owner/domain/location can also be edited on the policy page.
- **Dashboard charts** - donut of **successful vs failed** (and partial / incomplete / running) jobs for the selected day, stacked bars of **job outcomes per media server**, a **daily success-rate line** against the KPI target for the selected 7-90 day range, the 30-day outcome bars, and a **storage capacity chart for all media servers** (used vs free per media server from the latest pool snapshots, coloured by the warning/critical thresholds).
- **Layout** - the top bar shows only the portal name, the signed-in user and **Sign out** (or **Login** when signed out); all navigation is in a **side panel on the right** grouped as Monitoring, Reports, Storage & Policies, Requests and Administration (set `NAV_SIDE=left` in `.env` to move it to the left; on narrow screens it moves above the page). *Weekly* and *Monthly* reports are **one entry, Weekly / Monthly Report**, with Weekly | Monthly tabs inside the page.
- **Approval workflow for Backup Requests** - every submitted request goes through three approvals in order: **MTN Application Owner** (named on the request, with email) -> **MTN IT Manager** -> **Ison Backup Manager** (the last two are set once by an Administrator under *Approvals*, one or more emails each). The current approver gets an **email with a personal approve/reject link** (no login needed; single use, expires after `APPROVAL_LINK_DAYS`, default 14) and users whose portal email matches can also decide under *Approvals*. Each decision emails the next approver; a rejection (comment required) stops the chain and notifies the requester; the final approval notifies the requester and the backup engineers. Section D (engineer fulfilment) opens only after all three approvals; changing sections A-C restarts the chain; *Resend email* issues a fresh link. CSV-imported (already configured) entries need no approval.
- **WhatsApp approval** (optional) - the same three-step chain can also notify approvers on **WhatsApp**: each approver gets a message with the request summary, the personal link and **Approve / Reject** buttons. Approve is recorded straight from the tap; Reject asks for the reason, and the next text the approver sends becomes the rejection comment. Numbers: the *MTN Application Owner WhatsApp No.* field on the request (step 1) and per-step numbers under *Approvals* (steps 2-3, several allowed, any one can answer). E-mail keeps working in parallel and whichever channel answers first wins; the other link/buttons stop working. See *WhatsApp approval* below.
- **E-mail follow-up** (optional) - a backup engineer replies to the ticket mailbox (e.g. `netbackup-tickets@mtn.com`) with the **policy**, the **host name** and the **NetBackup job id** in the subject, for example `PRD_WIN_FULL | filesrv03 | Job 1003`. The text of the mail (without the quoted history and signature) is added as a remark on the **Failures & Follow-up** tab, marked *via e-mail*. See *E-mail follow-up* below.
- **Tape media forecast** - *Tape Media* page (inventory by media type such as **HCART5 / HCART6**: scratch, active, full, expired, expiring, offsite) and *Tape Media Forecast* report: **how many tapes of each type were used in the last 12 months** (per month, by volume pool, data written), and **how many to buy for the next 12 months**, with the calculation shown. Export CSV, Print / PDF, **e-mail** (send now with your own growth / buffer / reuse settings, or distribution lists of type *Tape media forecast*, sent automatically on `MONTHLY_MAIL_DAY`). See *Tape media forecast* below.
- **Daily tape scratch check** - *Tape Media -> Daily scratch check*: free (scratch) tapes per media type against a minimum. Only media **assigned from 1 Jan 2025 onward** is counted as free. When a type is below its minimum the portal e-mails the operators which tapes to **insert**: scratch tapes that are outside the library and Full tapes whose retention has expired (to expire / recycle, then insert), with media id, barcode, location and a CSV of all of them. Automatic once a day, or send now. See *Daily scratch check* below.
- **Last backup job sync** - the *Last backup job* of each policy/client is kept in a synced table that is **updated automatically with every daily report**; the **Resync last backup jobs** button on the Policies page rebuilds it from all stored jobs (case/space-insensitive policy-name matching) and names active policies that have no matching job.
- **Weekly report** - *Weekly Report* tab (Monday-Sunday week, same KPIs, charts, media-server table and storage section as the monthly report, compared with the previous week), CSV export, e-mail (send now, distribution lists of type *Weekly*, automatic mail on `WEEKLY_MAIL_DAY` (ISO weekday, default 1 = Monday) at `WEEKLY_MAIL_TIME`).
- **Dashboard** now shows **30 days** by default with 7/14/30/60/90-day selector and a summary for the selected range.
- **Storage pools** - the Storage Pools page is read-only: the media-server rename options (per entry and for all pools) and the pool-delete option were removed. Deleting a single snapshot on a pool's detail page is still available.
- **Backup Requests (policy request register)** - tab next to *NetBackup Policies*. A request form with **A. Server & Application** (hostname, IPv4-validated IP, OS, workload, backup mechanism, mount points/paths), **B. SLA & Retention** (frequency and retention dropdowns with *Custom*, optional window), **C. Ownership** (owner name, validated email and phone, department) and **D. Engineer fulfilment** (backup software, master/media server, policy name, storage pool/target, status, remarks; *Configured At/By* are stamped automatically when a request becomes *Configured / Active*). Section D is editable by Backup Engineers and Administrators only. Request list with status cards, filters and CSV export, request detail with full history, **CSV import** (template download, row-level validation, optional update of existing entries, default status *Configured / Active*).
- **Storage pool admin** - **Storage Pools** tab lists every pool; Administrators/Backup Engineers can delete a single snapshot from the pool detail page. **Media server name:** `nbdevquery -listdv/-listdp -U` does not print a media server, so when the output has no *Storage Server* field (and no `X-Media-Server` header) the portal derives it from the disk pool name - the last `-`/`_`/`.` separated part that contains letters and digits (`Diskpool-med01` -> `med01`, `DP_sznbuapp01` -> `sznbuapp01`). If the pool name has no such part (e.g. `DP_ADV_01`) it is stored as `unknown`; send the `X-Media-Server` header (or `STORAGE_MEDIA_SERVER` in the collector) in that case. Existing `unknown` snapshots are corrected at startup when the pool name allows it.
- **Failure report by e-mail** - **Mail** tab report types *Failure report - daily / weekly / monthly*: only failed, partial and incomplete jobs of the period (KPI cards, top failing servers, job table with engineer remarks, CSV attachment; an all-clear mail when there are none). Send now, or create distribution lists of those types with *Send automatically*: daily when the day's report arrives, weekly on `WEEKLY_MAIL_DAY`/`WEEKLY_MAIL_TIME` for the previous week, monthly on `MONTHLY_MAIL_DAY`/`MONTHLY_MAIL_TIME` for the previous month. A *E-mail failure report* button is on the Failures page.
- **E-mail reports** - **Mail** tab: send the daily or monthly report now (HTML summary in the body + CSV attachment), keep distribution lists, send automatically (daily mail when the day's report arrives; monthly mail on a set day for the previous month), test mail, and a mail log. Buttons on the dashboard and monthly page pre-fill the form.
- **Reports** - list of received reports, download the original CSV, administrators can delete.
- **Upload** - manual CSV import (Administrator, Backup Engineer) as a fallback.
- **Audit log** - logins, failed logins, API pushes/rejections, uploads, downloads, exports, remarks, user changes.
- **API** - `POST /api/v1/reports` with a bearer token; re-sending the same day replaces it (safe to re-run).

Additional role **Requester**: can only see the Backup Requests pages and their own requests (create, and edit while *Pending Review*). Everyone else can submit requests; Administrator, Backup Engineer and Team Lead can edit sections A-C of any request; only Administrator and Backup Engineer can edit section D and import CSV; only Administrators delete requests. Backup Engineer and Administrator manage storage pools. User e-mail addresses (Users tab) are used for the automatic *Configured By* field.

| Role | View | Upload / remark | Resolve remark | Audit log | Users / delete report |
|---|---|---|---|---|---|
| Administrator | yes | yes / yes | yes | yes | yes |
| Backup Engineer | yes | yes / yes | - | - | - |
| Team Lead | yes | - / yes | yes | yes | - |
| Management | yes (read-only) | - | - | - | - |

## Deploy
```bash
cp .env.example .env && vi .env      # INGEST_TOKEN, ADMIN_USER, ADMIN_PASSWORD, SECRET_KEY
docker compose up -d --build
curl http://localhost:8080/health    # {"status":"ok"}
```
Browse to `http://<host>:8080`, sign in with the bootstrap administrator (created only when the user table is empty), then change the password (top-right user name) and create users under **Users**. Data lives in the `mbop_data` volume (SQLite `mbop.db`) - back it up.

**HTTPS:** terminate TLS in front of the container (corporate reverse proxy, nginx or Caddy) and set `COOKIE_SECURE=1`. Do not expose port 8080 to the network without it, because the ingest token and passwords travel over it.

## Connect the report script
Linux/Unix primary (`netbackup_daily_report.conf`):
```
PORTAL_URL=https://mbop.example.com
PORTAL_TOKEN_FILE=/opt/netbackup/scripts/.portal_token     # chmod 600, contains INGEST_TOKEN
# PORTAL_CA_FILE=/path/to/corp-ca.pem                       # if the portal uses an internal CA
```
Windows primary (`netbackup_daily_report.config.json`): `PortalUrl`, `PortalTokenFile` (see the Windows README, section 9).

The script pushes right after writing the CSV. Test manually (replace host/token):
```bash
curl -X POST https://mbop.example.com/api/v1/reports \
  -H "Authorization: Bearer $INGEST_TOKEN" -H "X-Report-Date: 2026-11-14" \
  --data-binary @NetBackup_Daily_Report_20261114.csv
```
For several primary servers, give each its own report run; the portal keys reports by primary server name + date and the dashboard gets a server selector automatically.

## Monthly storage report - feeding storage data
Backup jobs do not contain storage capacity, so the report script collects it separately:
- Linux `.conf`: `STORAGE_REPORT=yes`, `STORAGE_STYPES=AdvancedDisk,PureDisk` (plus `PORTAL_URL`/`PORTAL_TOKEN_FILE`).
- Windows `.json`: `StorageReport: true`, `StorageStypes` (plus `PortalUrl`/`PortalTokenFile`).

The script runs `nbdevquery -listdp -stype <type> -U`, archives the raw text (`NetBackup_Storage_YYYYMMDD.txt`) and POSTs it to `/api/v1/storage/raw`; the portal parses disk pool, storage server (= media server), total capacity and free space. **The parser is tolerant but written without access to your NetBackup version's exact output** - Administrators can see every received text and how it parsed under **Upload -> View received raw output**; unparsable text is rejected with HTTP 422 and kept there. If it fails, send me that text and I will adjust the parser. Any other collector can use the JSON endpoint instead:
```bash
curl -X POST https://mbop.example.com/api/v1/storage -H "Authorization: Bearer $INGEST_TOKEN" -H "Content-Type: application/json" \
  -d '{"snapshot_date":"2026-11-15","master":"nbumaster01","pools":[{"media_server":"sznbuapp01","pool":"DP_ADV_01","stype":"AdvancedDisk","total_gb":10240,"free_gb":2048}]}'
```
Snapshots can also be pasted on the **Upload** page. Run the report daily so growth and days-to-full have data points. Optional settings in `.env`: `KPI_SUCCESS_TARGET` (default 98), `STORAGE_WARN_PCT` (80), `STORAGE_CRIT_PCT` (90).

## Backup policies - feeding policy data
Policy definitions are not in the job reports, so the script fetches them from NetBackup: Linux `.conf` `POLICY_REPORT=yes`, Windows `PolicyReport: true` (plus the portal URL/token settings). It runs `bppllist -allpolicies -U`, archives the text (`NetBackup_Policies_YYYYMMDD.txt`) and POSTs it to `/api/v1/policies/raw`; each import replaces that primary server's policy set. Administrators/Engineers can also paste the output on the **Policies** page; Administrators can see every received text and its parse result at **Policies -> View received raw output**.
How the extra columns are filled: **Storage** = media servers used by the policy's jobs in the last 30 days; **Size** = latest successful full-backup size of that client in that policy (from the stored daily reports, last 120 days); **Location** = maintained in the portal per client (Administrator/Backup Engineer); **Storage Unit** = the schedule's storage unit if it overrides the policy default, otherwise the policy's. **Excel files are read with a built-in dependency-free reader (no extra packages in the Docker image); only `.xlsx` is supported (not legacy `.xls` - save as Excel Workbook). The `bppllist -U` parser was written without your version's exact output** (as the storage parser was); if a policy import is rejected or fields are empty, send me the text from the raw view.

## E-mail
Set the SMTP variables in `.env` (`SMTP_SERVER`, `SMTP_PORT`, `SMTP_SECURITY` = none/starttls/ssl, `SMTP_USER`, `SMTP_PASSWORD` or `SMTP_PASSWORD_FILE` for a Docker secret, `MAIL_FROM`, `PORTAL_BASE_URL`) and restart. Then open **Mail**:
- **Send now:** choose daily (date) or monthly (YYYY-MM), primary server, a distribution list and/or extra addresses.
- **Distribution lists** (Administrator): per report type and primary server (blank = all). With *Send automatically* on, a daily list is mailed as soon as that day's report is received (re-pushing the same day does not resend), and a monthly list is mailed on `MONTHLY_MAIL_DAY` (default 1) after `MONTHLY_MAIL_TIME` (default 08:00) for the previous month. A failed monthly attempt is retried hourly until it succeeds.
- Roles: Administrator, Backup Engineer and Team Lead can send; only Administrators manage lists and send test mails; Management only receives.
- Every attempt (success or failure with the reason) is in the mail log and the audit log. The automatic monthly scheduler runs inside the single gunicorn worker (disable with `MAIL_SCHEDULER=0`; do not run several app replicas against one database).
Tested here against a fake SMTP server (content, attachments, validation, auto-send, de-duplication, scheduler timing, failure logging); delivery through your real mail relay (authentication, TLS) has not been tested.

## Tape media forecast
**Data source:** the portal had no tape information, so cartridges are loaded separately: on the *Tape Media* page (Administrator / Backup Engineer) upload a **CSV or Excel (.xlsx)** list, or paste the tape list - the one-line-per-tape output of **`vmquery -a -b`** (no header, as in `Y868L5 - HCART2 HOY868L5 - - NONE ... NetBackup 1 Scratch 89 0 - 06/23/2023 09:53 11/14/2025 07:20 ...`) or the multi-line **`vmquery -a -w`** output, or let a collector POST it to `POST /api/v1/tapes` (Bearer `INGEST_TOKEN`, headers `X-Master`, optional `X-Replace: 1`; example `tools/collect_tapes.sh`). **Any media type is accepted** (HCART, HCART2, HCART3, DLT2, LTO ...); nothing is limited to HCART5 / HCART6. Because NetBackup gives LTO-5 and LTO-6 the same type (HCART2), the **LTO generation is read from the barcode / media id suffix (`L5` = LTO-5, `L6` = LTO-6)** and the report groups by type and generation, e.g. `HCART2 / LTO-5`. To show them as HCART5 / HCART6 set `TAPE_TYPE_MAP=L5=HCART5,L6=HCART6`. In the one-line (`-a -b`) format fields are recognised by their shape and the dates are read in the order *created, assigned, first mount, last mount, expiration* (`TAPE_TABLE_DATES`, `00/00/0000` = not set; US month/day/year is detected automatically) - after every upload the message shows how the first row was read, **check that the assigned date is the one you expect** and reorder `TAPE_TABLE_DATES` if not. CSV / Excel columns (header names are matched loosely): **Media ID** and **Media Type** (e.g. HCART5, HCART6) are required; optional Barcode, Volume Pool, Status, Library, Vault/Location, Created, **Assigned**, Expiration, Last Written, Data Written (KB/MB/GB/TB), Mounts, Master Server. Date formats: ISO, `Thu Jan 10 12:00:00 2026`, Excel dates, and `dd/mm/yyyy` (set `TAPE_DATE_ORDER=mdy` for month first). Uploading again updates existing tapes; tick *Full inventory* to remove tapes that are no longer listed.
**What counts as "used":** a tape is used in the month its **Assigned** date falls in (the first write to a scratch tape). Every assigned date seen is kept in a usage history, so tapes that are later recycled are still counted for the year they were used - the history builds up with each upload (**upload regularly**; a first upload can only show the assignments still recorded on the cartridges).
**Forecast per media type** (assumptions are printed in the report and the e-mail):
1. *Used last 12 months* = tapes assigned in the last 12 complete calendar months (the current month is shown separately). *Previous 12 months* is the year before.
2. *Growth* = the growth % you enter, otherwise the year-on-year change (limited to -50%...+100%); flat when there is no full previous year (fewer than 6 tapes).
3. *Needed next 12 months* = tapes used in the same month last year x (1 + growth), summed over the next 12 months.
4. *Free supply* = scratch tapes + tapes whose retention has expired + tapes expiring within 12 months x *reuse %* (default 90). Frozen / suspended tapes are never counted.
5. *Recommended purchase* = needed x (1 + *buffer %*, default 10) - free supply, rounded up, never below 0.
The calculation is by tape count; it does not model tape capacity or the growth of backed-up data, so check it against the capacity plan. Defaults: `TAPE_BUFFER_PCT`, `TAPE_REUSE_PCT`, `TAPE_GROWTH_PCT` in `.env`.
**E-mail:** *Tape Media Forecast* page -> *E-mail this forecast* (uses the settings on the page), or *E-mail Reports* -> report *Tape media forecast* (as-of date, blank = today), or a distribution list of that type (automatic on the monthly mail day). The mail has the summary by media type, tapes used per month, the month-by-month forecast, the purchase calculation and tapes used by volume pool, and attaches a CSV with the list of every tape used in the period.
**The `vmquery` parser was written without access to your NetBackup version's exact output** (like the storage parser): rejected or empty uploads are listed under *Recent uploads*; send me a sample if tapes are not recognised. HCART5 / HCART6 are taken exactly as they appear in the *Media Type* column (vmquery's `1/2" cartridge tape 2` becomes `HCART2`); if your media list names LTO generations differently, add a Media Type column with the names you want.

## Daily scratch check
Keep the tape list current (run `tools/collect_tapes.sh` daily from cron, or upload it); the check reads the latest inventory and warns when it is older than `TAPE_STALE_DAYS`.
- **Free media (per media type)** = tapes in *Scratch* state that are **inside the library** (robot type other than NONE, not shelf / vault / offsite; unknown location counts as inside). Compared with the minimum `TAPE_SCRATCH_MIN` (default 20) or the per-type value in `TAPE_SCRATCH_MIN_MAP`.
- **Cut-off:** only media whose **assigned date is on or after `TAPE_FREE_FROM` (2025-01-01)** counts anywhere in this check - scratch tapes last assigned earlier are left out ("not counted" column), and so are old Full tapes. A tape that was never assigned has no date: counted by default (`TAPE_FREE_COUNT_NEW=1`), set `0` to count only tapes with an assigned date.
- **Tapes to insert** when a type is low: (1) scratch tapes outside the library, then (2) **Full / active tapes whose retention has ended** (`Expiration` on or before today) - these are reusable once expired / recycled. The first *shortfall* tapes are marked *Insert now*, the rest *Reserve*. If there are fewer candidates than the shortfall the mail says how many still have to be bought.
- **Full needs data:** the one-line `vmquery -a -b` list has no status and often no expiration date; a tape with an assigned date and no expiration is treated as Active (not a candidate). For "Full" tapes and their retention end, upload a CSV / Excel list with **Status** and **Expiration** columns (e.g. from `bpmedialist` / OpsCenter).
- **E-mail:** *Tape Media -> Daily scratch check -> E-mail this check* (send now), or create a distribution list of type **Tape scratch check** (E-mail Reports): it is sent **once a day after `TAPE_CHECK_TIME` (08:00) when a media type is low** (`TAPE_ALERT_ALWAYS=1` = also when everything is OK). The forecast report is not affected by this cut-off.

## E-mail follow-up
The portal **polls the ticket mailbox over IMAP** (it cannot receive mail itself), so create or reuse a mailbox for `netbackup-tickets@mtn.com`, enable IMAP on it and set in `.env`:
`FOLLOWUP_ENABLED=1`, `FOLLOWUP_MAILBOX`, `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURITY` (`ssl`/`starttls`/`none`), `IMAP_USER`, `IMAP_PASSWORD` (or `IMAP_PASSWORD_FILE`), then restart. Unread mail is checked every `FOLLOWUP_POLL_SECONDS` (120) and marked read once handled.
- **Subject:** must contain the job id, the host name and the policy name, in any order and with any separator; `Re:`/`Fw:` prefixes are ignored. The host may be the short name (`filesrv03`) or the FQDN. A number after `job`, `job id` or `#` is preferred as the job id.
- **Which job:** a *failed, partially successful or incomplete* job of the last `FOLLOWUP_LOOKBACK_DAYS` (90) days whose job id, host and policy all match. If the same id exists on several master servers the mail is refused (add the master name to the subject); if the id repeats on several days the latest one is used.
- **Who may reply:** the sender address must belong to an **active portal user** whose role may add remarks (Administrator, Backup Engineer, Team Lead); the remark is recorded under that user. Mail whose `Authentication-Results` header shows a failed SPF/DKIM/DMARC check, automatic replies (out-of-office, bounces) and mail from the portal's own addresses are ignored. Make sure the mailbox's mail server performs SPF/DKIM/DMARC checks, otherwise a forged *From* address cannot be detected.
- **Feedback:** the engineer gets a confirmation e-mail (or a hint with the expected subject format when nothing matched) when SMTP is configured; switch off with `FOLLOWUP_ACK=0`. Administrators and Team Leads see an *E-mail follow-up log* (recorded / no match / rejected ...) under the Failures table, and the page shows when the mailbox was last checked and the last error.
- **No IMAP?** A mail gateway or flow can instead POST the raw message (RFC 822) to `POST /api/v1/followup/email` with `Authorization: Bearer <INGEST_TOKEN>`; the answer is JSON (`recorded`, `no match`, `rejected`, ...). Microsoft 365 note: basic-auth IMAP is disabled in many tenants - use a mailbox with IMAP basic/app-password access allowed, or the gateway endpoint.
- The same mail is never processed twice (tracked by Message-ID). Replying to the portal's own report mails also works if the subject carries the three items.

## WhatsApp approval
Uses the Meta **WhatsApp Business Cloud API**. Set it up once:
1. In Meta Business / developers.facebook.com create an app with the WhatsApp product, add a business phone number and note its **Phone number ID**; create a **system user permanent token** with `whatsapp_business_messaging`. Note the **App secret** (App settings -> Basic).
2. Create a message template (category *Utility*, name e.g. `backup_approval_request`, language `en`) with this body and two **Quick reply** buttons, *Approve* and *Reject*:
   ```
   Backup request {{1}} for server {{2}} needs your approval as {{3}} (step {{4}} of 3). {{5}}. Full details: {{6}}
   ```
   Sample values for review: `BR-000012`, `app01.corp.local`, `MTN IT Manager`, `2`, `Daily Full, kept 30 Days, requested by jane`, `https://mbop.example.com/approve/abc123`. (Template messages are required to message people first; Meta must approve the template before it works.)
3. Fill the `WHATSAPP_*` variables in `.env` (`WHATSAPP_ENABLED=1`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_TEMPLATE_NAME`, and `WHATSAPP_DEFAULT_COUNTRY_CODE` if people type local numbers such as `097...`) and restart.
4. In the Meta app, WhatsApp -> Configuration: callback URL `https://<portal>/api/v1/whatsapp/webhook` (shown on the *Approvals* page), the same verify token, and subscribe to the **messages** field. The portal must be reachable from the internet over HTTPS for this; without the webhook the message and link still go out, but buttons/replies do nothing - set `WHATSAPP_REPLY_APPROVAL=0` and use a template without buttons in that case.
5. Enter the numbers: *Approvals -> Approval chain settings* (steps 2-3, international format such as `+260971234567`) and the WhatsApp field of each new request (step 1). **Approvals** page (Administrator) shows the WhatsApp log (numbers masked) with Meta's error text for any failed send.

Security: webhook calls are accepted only with a valid `X-Hub-Signature-256` (HMAC of the body with the app secret; without `WHATSAPP_APP_SECRET` they are refused); a button tap counts only when it comes from a number listed for that step and carries the step's single-use token; repeated Meta deliveries are ignored; a stale button (already decided by e-mail/portal, resent or expired) is answered with a notice. Outcome mails to the requester and the engineers remain e-mail only. Without `WHATSAPP_TEMPLATE_NAME` the portal sends free-form messages with buttons, which WhatsApp only delivers to people who messaged your number in the last 24 hours (useful for testing with the Meta sandbox number).
**Not tested against Meta's live service** (no network here): the code was tested against a fake Cloud API server (payloads, signature, buttons, reject-reason flow, failures). Check the first real message end to end and the Graph API version (`WHATSAPP_API_VERSION`).

## Try it with demo data
```bash
python3 tools/seed_demo.py http://localhost:8080 "$INGEST_TOKEN" 14     # 14 days of synthetic reports
```
Delete them afterwards under **Reports** (administrator). `samples/NetBackup_Daily_Report_20261114.csv` is a real-format sample you can upload via **Upload**.

## Tests
```bash
pip install flask && python3 -m unittest discover -s tests -v      # 212 tests incl. tape scratch check, tape forecast, e-mail follow-up, WhatsApp approval, failure-report mail and the listdv parser, dashboard charts, layout, approvals, weekly report, last-job sync and pool admin
```

## Security notes
Passwords hashed (scrypt via Werkzeug); lockout after 5 failures for 10 minutes; CSRF tokens on all forms; HTML escaped in all pages; session cookie HttpOnly/SameSite=Lax (+Secure with HTTPS); CSP and no-store headers; container runs as non-root with a read-only filesystem; ingest token compared in constant time; every sensitive action audited.

## Scope and next steps
Included now: reporting, follow-up, roles, audit. Not included yet (from your MBOP scope): approval workflow for reports, e-mail report scheduling from the portal, SSO/LDAP login, and a PostgreSQL backend (SQLite is fine for a single-site daily load; switch if you need several app instances). Tell me which to build next.

Limitations: the portal shows what the script reports - backup size is data written by the job (not logical/physical dedup size). The Docker image build and the HTTPS proxy were not run here; the application itself was tested with Flask's test client and a live local server.


## Storage utilization & projection (capacity planning)
**Storage Utilization** (side menu, *Storage & Policies*) shows, for every media server / appliance and for all of them together, the used capacity history (sum of the server's disk pools per snapshot date) with a **straight-line projection** for 3 / 6 / 12 months, the capacity line and the warning / critical limits (`STORAGE_WARN_PCT` / `STORAGE_CRIT_PCT`). For each server it shows current used / capacity, growth in GB/day and TB/month, projected used at +3 / +6 / +12 months (TB and % of capacity), the **dates the warning limit, the critical limit and 100% will be reached**, the **extra capacity needed to stay under the warning limit** at the chosen horizon and a trend confidence (R²). A second table does the same per disk pool. Choose the history window (90 days / 180 days / 12 months / all) and the horizon; **Export Excel / CSV** gives the summary with real numbers for your own planning. The projection needs at least 3 snapshots over 7 days (run the storage collector daily). It is a planning aid: expired backups, new capacity or step changes make real growth non-linear, so check the confidence and re-run after each retention cycle. Appliances (e.g. PureDisk / MSDP pools) appear as soon as the collector reports them.

## Mobile (phones and tablets)
The whole portal is responsive: on screens up to 900 px the side navigation becomes a **slide-in menu** (button at top left; opens from the right, or the left with `NAV_SIDE=left`), cards show two per row, filters and forms use full-width fields with large touch targets, wide tables and charts scroll inside their own box (no sideways page scrolling - checked on all pages at phone width), and the approval link page works the same way on a phone.
It is also an installable **web app (PWA)**: open the portal in Chrome / Edge on Android and choose *Install app* (or the *Install app* button in the top bar), or in Safari on iPhone / iPad choose *Share -> Add to Home Screen*. It then opens full screen with its own icon. Installation and the service worker need the portal to be served over **HTTPS** (a normal HTTP address only works as a mobile website). Pages are always loaded live (no data is stored on the device); when the network is unreachable a short offline page is shown. A native iOS / Android store app is not part of this package.
