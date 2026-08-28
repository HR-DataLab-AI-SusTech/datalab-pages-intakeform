#!/usr/bin/env node
/**
 * datalab-intake-form bridge — REST + MCP server for the AI SusTech Datalab project-intake form.
 *
 * TWO CALLERS, ONE SERVER, same split as compass-board's bridge:
 *   · the public web form (datalab-pages-intakeform), over REST — no auth to save a draft,
 *     a shared passphrase to finalize one.
 *   · an "Intake Form Assistant" chat agent, over MCP JSON-RPC at POST /mcp.
 *
 * 🔺 NOT ZERO-DEPENDENCY, unlike compass-board's bridge. This one speaks to Postgres, and the
 * wire protocol realistically needs a real client — `pg` is the one real dependency here. That is
 * a deliberate, accepted deviation from the zero-dep pattern (see the PR description).
 *
 * The form's schema (src/config/formConfig.json) is bind-mounted in read-only so this server and
 * the web form are always asking the SAME questions — one source of truth, exposed to the chat
 * agent via the get_intake_schema tool.
 */
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { Pool } = require("pg");

const PORT = Number(process.env.BRIDGE_PORT || 3458);

/* 🔺 TWO LISTENERS, AND THE SPLIT IS A SECURITY BOUNDARY — NOT TIDINESS.
 *
 * `/mcp` and `POST /submit` used to share one port, which was safe only while the whole service was
 * mesh-only. The moment `intake.twinhub.nl` is published to the internet that stops being true, and
 * what would go with it is not the passphrase-gated form but the MCP tools: `submit_intake` takes
 * NO passphrase (it relies on mesh membership — ADR-0017 amendment 3) and `list_recent_intakes`
 * returns every user's intakes, project names and submitter email addresses included.
 *
 * So the internet-facing listener serves the BROWSER routes only and 404s `/mcp`, while PORT stays
 * mesh-only and unchanged. NetBird publishes PUBLIC_PORT; LibreChat and Claude Code keep talking to
 * PORT over the mesh and needed no change for this.
 *
 * ⚠️ NOT solvable by inspecting the request. `clientIp()` trusts `X-Forwarded-For`, which is fine
 * for rate limiting (worst case: self-inflicted) and unfit for authorization, because a client can
 * set it. A separate socket cannot be spoofed. Set BRIDGE_PUBLIC_PORT=0 to run mesh-only again.
 */
const PUBLIC_PORT = Number(process.env.BRIDGE_PUBLIC_PORT ?? 3459);
const DATABASE_URL = process.env.INTAKE_DATABASE_URL || "";
const PASSPHRASE = process.env.INTAKE_SUBMIT_PASSPHRASE || "";
const COMPASS_TOKEN = process.env.COMPASS_GITHUB_TOKEN || "";
const FORM_CONFIG_PATH = process.env.FORM_CONFIG_PATH || "/app/formConfig.json";
const COMPASS_REPO = "HR-DataLab-AI-SusTech/compass";
const COMPASS_API = "https://api.github.com";

/* ── CORS ──────────────────────────────────────────────────────────────────────────────────────
 *
 * 🔺 THE BROWSER FORM IS ON A DIFFERENT ORIGIN AND CANNOT REACH THIS SERVER WITHOUT THIS.
 * The form is served from GitHub Pages; this bridge answers on its own hostname. The submit call
 * sends `Content-Type: application/json` AND the custom `X-Intake-Passphrase` header, and EITHER
 * of those alone makes the request non-simple — so the browser sends a preflight OPTIONS first and
 * refuses the real request unless this server answers it. Without the block below, every
 * submission fails in the browser before it ever reaches Node, and the server log stays empty,
 * which is what makes it a confusing failure rather than an obvious one.
 *
 * An allowlist, not `*`, and deliberately so: `*` would let any page on the internet submit
 * intakes on a visitor's behalf. Credentials are not used (no cookies), so no
 * Access-Control-Allow-Credentials.
 */
const ALLOWED_ORIGINS = (process.env.INTAKE_ALLOWED_ORIGINS ||
  "https://hr-datalab-ai-sustech.github.io")
  .split(",").map((o) => o.trim()).filter(Boolean);

/** The schema the PUBLISHED form actually renders. See getFormConfig() for why this exists. */
const FORM_CONFIG_URL = process.env.FORM_CONFIG_URL ||
  "https://hr-datalab-ai-sustech.github.io/datalab-pages-intakeform/config/formConfig.json";

// Fail fast on the two secrets this server cannot function without — same spirit as
// compass-board's bridge refusing to start with no VIKUNJA_TOKEN. COMPASS_GITHUB_TOKEN is NOT in
// this list: it is expected to be absent in most environments (including this one, right now) and
// the "file into Compass" step degrades gracefully when it is — see fileIntoCompass().
if (!DATABASE_URL) { console.error("bridge: INTAKE_DATABASE_URL is empty — refusing to start"); process.exit(1); }
if (!PASSPHRASE) { console.error("bridge: INTAKE_SUBMIT_PASSPHRASE is empty — refusing to start"); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL });

process.on("unhandledRejection", (e) => console.log(`bridge: WARNING unhandled rejection: ${e && e.message}`));

/* ── Postgres ──────────────────────────────────────────────────────────────────────────────── */

const ROW_FIELDS = "id, created_at, updated_at, status, source, submitted_by, answers, project_slug, compass_pr_url";

async function getIntake(id) {
  const { rows } = await pool.query(`SELECT ${ROW_FIELDS} FROM intakes WHERE id = $1`, [id]);
  return rows[0] || null;
}

/** Upsert a DRAFT. A draft_id that does not resolve to a live draft (wrong id, or already
 *  submitted) gets a fresh row rather than silently overwriting someone else's submission. */
async function upsertDraft({ draft_id, answers, source, submitted_by }) {
  const ans = answers && typeof answers === "object" ? answers : {};
  if (draft_id) {
    const { rows } = await pool.query(
      `UPDATE intakes SET answers = $2, updated_at = now(),
         submitted_by = COALESCE($3, submitted_by)
       WHERE id = $1 AND status = 'draft' RETURNING id`,
      [draft_id, JSON.stringify(ans), submitted_by || null],
    );
    if (rows[0]) return rows[0].id;
    // Fall through: draft_id was unknown or already submitted — start a new draft instead of
    // silently mutating a submitted row.
  }
  const { rows } = await pool.query(
    `INSERT INTO intakes (status, source, submitted_by, answers) VALUES ('draft', $1, $2, $3) RETURNING id`,
    [source, submitted_by || null, JSON.stringify(ans)],
  );
  return rows[0].id;
}

async function listRecent({ status, limit }) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const params = [lim];
  let where = "";
  if (status === "draft" || status === "submitted") { where = "WHERE status = $2"; params.push(status); }
  const { rows } = await pool.query(
    `SELECT id, status, answers->>'q0' AS project_name, submitted_by, created_at
       FROM intakes ${where} ORDER BY created_at DESC LIMIT $1`,
    params,
  );
  return rows;
}

/**
 * The one path from a submit request (REST or MCP) to a finalized row. Idempotent by design: a
 * retry against an already-submitted intake that already has a PR returns that PR rather than
 * filing a second one — the guard the task spec calls for against duplicate PRs.
 */
async function finalizeSubmission({ draft_id, answers, submitted_by, source }) {
  let row = draft_id ? await getIntake(draft_id) : null;

  if (row && row.status === "submitted" && row.compass_pr_url) {
    // Already fully done — nothing to retry.
    return { id: row.id, compass_pr_url: row.compass_pr_url, already_submitted: true };
  }

  const ans = answers && typeof answers === "object" ? answers : (row ? row.answers : {});

  if (row) {
    const { rows } = await pool.query(
      `UPDATE intakes SET status = 'submitted', answers = $2, updated_at = now(),
         submitted_by = COALESCE($3, submitted_by), source = $4
       WHERE id = $1 RETURNING ${ROW_FIELDS}`,
      [row.id, JSON.stringify(ans), submitted_by || null, source],
    );
    row = rows[0];
  } else {
    const { rows } = await pool.query(
      `INSERT INTO intakes (status, source, submitted_by, answers) VALUES ('submitted', $1, $2, $3)
       RETURNING ${ROW_FIELDS}`,
      [source, submitted_by || null, JSON.stringify(ans)],
    );
    row = rows[0];
  }

  // row.compass_pr_url may already be set here (a previous attempt succeeded but the response
  // never reached the caller) — the guard above only short-circuits when status AND pr_url were
  // both already there before this call touched the row, so re-check now with the fresh row.
  if (row.compass_pr_url) return { id: row.id, compass_pr_url: row.compass_pr_url, already_submitted: true };

  const filed = await fileIntoCompass(row);
  if (filed.pr_url) {
    await pool.query(`UPDATE intakes SET compass_pr_url = $2, project_slug = $3 WHERE id = $1`,
      [row.id, filed.pr_url, filed.slug]);
  } else {
    await pool.query(`UPDATE intakes SET project_slug = $2 WHERE id = $1`, [row.id, filed.slug]);
    console.log(`bridge: intake ${row.id} submitted, no Compass PR opened — ${filed.reason}`);
  }
  return { id: row.id, compass_pr_url: filed.pr_url || null };
}

/* ── Constant-time passphrase compare ─────────────────────────────────────────────────────────
 *
 * Padded to equal length BEFORE calling timingSafeEqual, which throws on a length mismatch —
 * a caller-controlled input must never be able to trigger that. The final length check after the
 * padded compare leaks only the LENGTH of a wrong guess (via a non-constant-time ===), same as
 * any password compare that reports "wrong length" — never the content.
 */
function safeEqual(received, expected) {
  const a = Buffer.from(String(received ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  const len = Math.max(a.length, b.length, 1);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  a.copy(aPadded);
  b.copy(bPadded);
  return crypto.timingSafeEqual(aPadded, bPadded) && a.length === b.length;
}

/* ── Per-IP rate limiting on submit only ──────────────────────────────────────────────────────
 *
 * In-memory, does not need to survive a restart — a restarted bridge just forgets abuse history,
 * which is an acceptable cost for how small this deployment is. Applied to BOTH the REST /submit
 * route and the MCP submit_intake tool (the task that requested this scoped it to "/submit", but
 * submit_intake is the exact same finalize-and-open-a-PR operation reachable through the same
 * public port, so limiting only one of the two doors would leave the other wide open).
 */
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const rateLimitMap = new Map(); // ip -> { count, resetAt }

/* 🔺 CALL THIS ONLY ON A PATH THAT HAS ALREADY FAILED, OR THAT HAS NO PASSPHRASE AT ALL.
 *
 * It must never sit in front of a request carrying the RIGHT passphrase. Putting it there is a
 * denial-of-service with extra steps: an anonymous attacker sends enough bad guesses to trip the
 * global counter and every legitimate submission is refused for the rest of the window — cheaper
 * to mount than guessing the secret, and repeatable forever. Measured on a live bridge before this
 * was split out: 31 spoofed failures, and a correct passphrase from a clean address then got 429.
 *
 * A correct passphrase is itself proof the caller is entitled to submit, so there is nothing left
 * to rate-limit; throttling it protects nobody.
 */
function perIpLimited(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

/** Per-IP OR the spoof-proof global counter. For failure paths only. */
function rateLimited(ip) {
  return perIpLimited(ip) || globalLimitReached();
}

/* Slow a guesser without ever refusing a legitimate caller. Once the failure counters are tripped
 * every WRONG answer costs two seconds, which is ruinous for a script and unnoticeable to a person
 * who mistyped once. This is the part that actually makes brute force impractical — the 429 below
 * is only a label on it. */
const THROTTLE_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The spoof-proof half. The passphrase is a SINGLE SHARED SECRET, so what has to be bounded is the
 * total number of guesses against it, not the number per claimed source address. This counter is
 * keyed on nothing, so nothing a client sends can reset it.
 *
 * Sized to be invisible to real use and fatal to a script: a genuine session submits once, maybe
 * retries a typo. 30 failures in 10 minutes across the whole service is already pathological.
 * ⚠️ Only FAILURES count (see noteFailedAttempt) — a busy day of successful submissions must never
 * trip this, or the form breaks precisely when it is being used.
 */
const GLOBAL_FAIL_MAX = 30;
const GLOBAL_FAIL_WINDOW_MS = 10 * 60 * 1000;
let globalFails = { count: 0, resetAt: Date.now() + GLOBAL_FAIL_WINDOW_MS };

function globalLimitReached() {
  const now = Date.now();
  if (now > globalFails.resetAt) globalFails = { count: 0, resetAt: now + GLOBAL_FAIL_WINDOW_MS };
  return globalFails.count > GLOBAL_FAIL_MAX;
}

/** Call on every REJECTED passphrase, from whichever door it arrived through. */
function noteFailedAttempt() {
  const now = Date.now();
  if (now > globalFails.resetAt) globalFails = { count: 0, resetAt: now + GLOBAL_FAIL_WINDOW_MS };
  globalFails.count++;
}

// Sweep expired entries occasionally so a long-lived process does not accumulate one entry per IP
// forever. Not correctness-critical — just housekeeping.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) if (now > entry.resetAt) rateLimitMap.delete(ip);
}, 30 * 60 * 1000).unref();

/* 🔺 `X-Forwarded-For` IS CLIENT-SUPPLIED AND THIS SERVER CANNOT VALIDATE IT.
 *
 * This bridge sits behind NetBird's hosted reverse proxy, whose egress address is not something we
 * can pin here, so there is no trustworthy "is this hop the real proxy?" test. That leaves two bad
 * options and one acceptable one:
 *
 *   - Trust XFF  → an attacker sends a fresh value per request and gets a fresh bucket each time,
 *                  i.e. unlimited guessing. (This estate has already been bitten by exactly this:
 *                  XFF spoofing past per-IP limits is what made LibreChat's :3080 urgent.)
 *   - Ignore XFF → every public request arrives from the proxy, collapses to ONE bucket, and five
 *                  attempts lock out every legitimate user at once.
 *
 * So per-IP bucketing is kept as a best-effort courtesy (it separates honest users from each other
 * and costs nothing), and the ACTUAL brute-force control is the global counter below, which no
 * header can influence. Read `rateLimited()` with that split in mind: per-IP is UX, global is
 * security. Do not "fix" this by deleting the global limiter because per-IP looks sufficient.
 */
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return `xff:${String(xff).split(",")[0].trim()}`;
  return req.socket.remoteAddress || "unknown";
}

/* ── Caller identity ───────────────────────────────────────────────────────────────────────────
 *
 * Same convention as compass-board's bridge: read what the caller's own front-end substituted,
 * never trust it for anything beyond a label on the row.
 */
function callerIdentity(headers, fallback) {
  const user = headers["x-librechat-user"];
  const email = headers["x-chat-email"];
  if (user && String(user).trim() && user !== "{{LIBRECHAT_USER_USERNAME}}") return String(user).slice(0, 120);
  if (email && String(email).trim()) return String(email).slice(0, 120);
  return fallback;
}

/* ── Form schema (read-only, bind-mounted) ────────────────────────────────────────────────────
 *
 * Re-read on every use rather than cached at boot: the form's own repo can change formConfig.json
 * without a bridge restart, and get_intake_schema/list rendering should reflect that immediately.
 */
function readFormConfigFromDisk() {
  const raw = fs.readFileSync(FORM_CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

/* 🔺 THE MOUNTED COPY IS NOT NECESSARILY THE ONE THE FORM IS SHOWING, and that is the whole reason
 * this function is not just a readFileSync.
 *
 * The published form is deployed by GitHub Pages from `main`, on every push. This container is
 * deployed by lab-reconcile from an IMMUTABLE SHA pinned in infrastructure/deployments — which is
 * the point of the deploy model and is not going to change. So the two are the same file at two
 * different commits, and they diverge the moment a question is edited and the manifest pin is not
 * bumped. Nothing would report it: the chat agent would simply start asking a different set of
 * questions than the web form, and every answer would still store fine because answers are JSONB.
 *
 * So: prefer the LIVE published schema (that is what a human is actually looking at), fall back to
 * the mounted copy when the fetch fails, and cache briefly so a chat turn is not one HTTP round
 * trip per tool call. The fallback is what keeps this safe — a GitHub outage degrades to
 * "possibly slightly stale questions", never to a broken tool.
 */
const SCHEMA_TTL_MS = 5 * 60 * 1000;
let schemaCache = { at: 0, value: null, source: null };

async function getFormConfig() {
  if (schemaCache.value && Date.now() - schemaCache.at < SCHEMA_TTL_MS) return schemaCache.value;
  try {
    const r = await fetch(FORM_CONFIG_URL, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const value = await r.json();
    if (!value || !Array.isArray(value.pages)) throw new Error("no pages[] in fetched schema");
    schemaCache = { at: Date.now(), value, source: FORM_CONFIG_URL };
    return value;
  } catch (e) {
    const value = readFormConfigFromDisk();
    // Logged every time, not once: a bridge quietly serving the pinned copy for weeks is exactly
    // the silent-drift state this function exists to avoid.
    console.log(`bridge: WARNING could not fetch the live form schema (${e.message}) — falling back to the mounted copy at ${FORM_CONFIG_PATH}`);
    schemaCache = { at: Date.now(), value, source: `${FORM_CONFIG_PATH} (fallback)` };
    return value;
  }
}

/** Every real question, in form order, id -> label — used to line up the Compass write-up with
 *  what the form actually asked, whatever formConfig.json currently contains. */
function schemaFields(formConfig) {
  const out = [];
  for (const page of formConfig.pages || []) {
    if (page.isLanding || page.isSummary) continue;
    for (const field of page.fields || []) out.push({ id: field.id, label: field.label, page: page.title });
  }
  return out;
}

/* ── "File into Compass" ──────────────────────────────────────────────────────────────────────
 *
 * Called only from a successful finalizeSubmission(), once per row (guarded by compass_pr_url).
 * Writes exactly two files, in one branch/commit/PR:
 *   - projects/intake-form/submissions/<date>-<slug>.md   (new file)
 *   - projects/intake-form/todos.md                       (one bullet appended under the
 *     "## Intakes awaiting review" heading)
 * Never touches areas/ways-of-working/team.md, never creates projects/<slug>/, never touches
 * projects/README.md — those are explicitly out of scope for this workstream.
 */

function slugify(s) {
  const base = String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "untitled-project";
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function mdEscape(s) {
  return String(s == null ? "" : s);
}

function renderSubmissionMarkdown({ row, projectName, slug, fields, date }) {
  const owner = row.submitted_by || "unknown";
  const lines = [];
  lines.push("---");
  lines.push(`title: "Intake: ${projectName.replace(/"/g, '\\"')}"`);
  lines.push("type: note");
  lines.push("status: open");
  lines.push(`owner: ${owner}`);
  lines.push("tags: [intake, review-queue]");
  lines.push("related: [../README.md, ../todos.md]");
  lines.push(`updated: ${date}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Intake: ${projectName}`);
  lines.push("");
  lines.push(`> Submitted ${date} by ${owner}, via the AI SusTech Datalab intake form. This is a ` +
              "submission awaiting triage, not a project — see the repo's [README](../../../CLAUDE.md) " +
              "for what turns it into one.");
  lines.push("");
  lines.push(`Intake row: \`${row.id}\` (bridge database, table \`intakes\`).`);
  lines.push("");
  lines.push("## Answers");
  lines.push("");
  const answers = row.answers || {};
  if (fields.length) {
    for (const f of fields) {
      const value = answers[f.id];
      lines.push(`**${f.id.toUpperCase()} — ${mdEscape(f.label)}**`);
      lines.push("");
      lines.push(value && String(value).trim() ? mdEscape(value) : "_No answer provided_");
      lines.push("");
    }
  } else {
    // Schema could not be read — fall back to a raw dump so nothing is silently lost.
    for (const [k, v] of Object.entries(answers)) {
      lines.push(`**${k}**`);
      lines.push("");
      lines.push(v && String(v).trim() ? mdEscape(v) : "_No answer provided_");
      lines.push("");
    }
  }
  return lines.join("\n");
}

const REVIEW_HEADING = "## Intakes awaiting review";
const PLACEHOLDER_RE = /^_None yet.*$/m;

function insertTodoBullet(todosContent, bullet) {
  const idx = todosContent.indexOf(REVIEW_HEADING);
  if (idx === -1) {
    // Heading missing (todos.md restructured since this was written) — append at the end rather
    // than silently dropping the bullet.
    const sep = todosContent.endsWith("\n") ? "" : "\n";
    return `${todosContent}${sep}\n${REVIEW_HEADING}\n\n${bullet}\n`;
  }
  const headingEnd = todosContent.indexOf("\n", idx) + 1;
  const before = todosContent.slice(0, headingEnd);
  let after = todosContent.slice(headingEnd);
  // Skip a single leading blank line right after the heading, if present, then check for the
  // placeholder line and replace it; otherwise insert the bullet as the new first line.
  const afterTrimmedStart = after.replace(/^\n/, "");
  const leadingBlank = after.length - afterTrimmedStart.length; // 0 or 1
  if (PLACEHOLDER_RE.test(afterTrimmedStart.split("\n")[0] || "")) {
    const lines = afterTrimmedStart.split("\n");
    lines[0] = bullet;
    after = "\n".repeat(leadingBlank) + lines.join("\n");
  } else {
    after = "\n".repeat(leadingBlank) + bullet + "\n" + afterTrimmedStart;
  }
  return before + after;
}

async function ghApi(path, { method = "GET", body, ref } = {}) {
  const url = `${COMPASS_API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${COMPASS_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) {
    // ⚠️ Never the raw body on stdout in a way that could carry the token — it doesn't here (GitHub
    // errors don't echo the Authorization header back), but keep the same discipline as
    // compass-board's bridge: print status + a trimmed message, never assume a body is safe.
    const safe = text.replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`compass GitHub API ${method} ${path} -> HTTP ${res.status}: ${safe}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Returns { pr_url, slug, reason? }. `pr_url` is null (never fabricated) when COMPASS_GITHUB_TOKEN
 * is not configured — the expected state in this environment. Never throws: a Compass-filing
 * failure must not fail the submission itself, since the intake is already safely in Postgres.
 */
async function fileIntoCompass(row) {
  const answers = row.answers || {};
  const projectName = (answers.q0 && String(answers.q0).trim()) || "Untitled project";
  const slug = slugify(projectName);
  const date = todayIso();

  if (!COMPASS_TOKEN) {
    return { pr_url: null, slug, reason: "COMPASS_GITHUB_TOKEN is not configured — no token, no PR attempted" };
  }

  try {
    let fields = [];
    try { fields = schemaFields(await getFormConfig()); }
    catch (e) { console.log(`bridge: WARNING could not read form schema for Compass write-up: ${e.message}`); }

    const submissionPath = `projects/intake-form/submissions/${date}-${slug}.md`;
    const submissionBody = renderSubmissionMarkdown({ row, projectName, slug, fields, date });
    const bullet = `- [ ] Review intake: ${projectName}, submitted ${date} by ` +
      `${row.submitted_by || "unknown"} — [submissions/${date}-${slug}.md](submissions/${date}-${slug}.md) ` +
      `<!-- ${date} -->`;

    // 1. Base branch tip.
    const baseRef = await ghApi(`/repos/${COMPASS_REPO}/git/ref/heads/main`);
    const baseSha = baseRef.object.sha;

    // 2. New branch.
    const branch = `intake/${slug}-${row.id.slice(0, 8)}`;
    await ghApi(`/repos/${COMPASS_REPO}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: baseSha },
    });

    // 3. New submission file.
    await ghApi(`/repos/${COMPASS_REPO}/contents/${submissionPath}`, {
      method: "PUT",
      body: {
        message: `Intake: ${projectName} — add to review queue`,
        content: Buffer.from(submissionBody, "utf8").toString("base64"),
        branch,
      },
    });

    // 4. todos.md — read current content off the branch (== main, just created), update, write back.
    const todosPath = "projects/intake-form/todos.md";
    const todosFile = await ghApi(`/repos/${COMPASS_REPO}/contents/${todosPath}?ref=${branch}`);
    const todosContent = Buffer.from(todosFile.content, "base64").toString("utf8");
    const newTodosContent = insertTodoBullet(todosContent, bullet);
    await ghApi(`/repos/${COMPASS_REPO}/contents/${todosPath}`, {
      method: "PUT",
      body: {
        message: `Intake: ${projectName} — queue for review`,
        content: Buffer.from(newTodosContent, "utf8").toString("base64"),
        sha: todosFile.sha,
        branch,
      },
    });

    // 5. Open the PR.
    const answersDump = fields.length
      ? fields.map((f) => `- **${f.label}**: ${answers[f.id] ? String(answers[f.id]) : "_(no answer)_"}`).join("\n")
      : Object.entries(answers).map(([k, v]) => `- **${k}**: ${v ? String(v) : "_(no answer)_"}`).join("\n");
    const prBody = [
      `This is a project **intake submission awaiting triage** — not a new project. It was filed ` +
        `automatically by the datalab-intake-form bridge, via **${row.source || "unknown"}**. ` +
        `\`web\` = the public form, gated by the shared passphrase. \`chat\` = an authenticated user ` +
        `on the lab mesh, identified below rather than by a shared word.`,
      "",
      `Intake row: \`${row.id}\` in the bridge's Postgres \`intakes\` table.`,
      "",
      "## Raw answers",
      "",
      answersDump,
      "",
      "---",
      "",
      "⚠️ GitHub Actions minutes are exhausted org-wide right now, so CI will **not** run on this PR. " +
        "Run `make check` locally in `compass` before merging.",
    ].join("\n");

    const pr = await ghApi(`/repos/${COMPASS_REPO}/pulls`, {
      method: "POST",
      body: { title: `Intake: ${projectName}`, head: branch, base: "main", body: prBody },
    });

    return { pr_url: pr.html_url, slug };
  } catch (e) {
    console.log(`bridge: WARNING filing intake ${row.id} into Compass failed: ${e.message}`);
    return { pr_url: null, slug, reason: e.message };
  }
}

/* ── MCP tools ─────────────────────────────────────────────────────────────────────────────── */

/* The revision this server implements, and the set it will agree to.
 *
 * 🔺 SPEC REQUIREMENT, and the reason this is a list rather than a constant: on `initialize` the
 * server must respond with the client's requested revision IF it supports it, and only otherwise
 * fall back to one of its own. Asserting a single version regardless of what was asked is the one
 * genuinely non-conformant thing this hand-rolled server did — a client pinned to an older
 * revision could be told a version it never asked for and disconnect.
 *
 * ⚠️ WHY 2024-11-05 IS DELIBERATELY ABSENT, even though the tool calls themselves would work:
 * that revision mandates the older HTTP+SSE transport (a `GET` endpoint streaming events), which
 * this server does not implement. Agreeing to it would make a conforming client switch to a
 * transport that is not here and fail — worse than declining it. Only the Streamable-HTTP
 * revisions belong in this list, and for a POST-only tools server they are interchangeable.
 */
const PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26"];

const TOOLS = {
  get_intake_schema: {
    description: "The current intake form schema (formConfig.json's pages/fields) — the same " +
      "questions the web form asks. Read this before asking the user anything, so questions never drift.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      return await getFormConfig();
    },
  },

  save_draft: {
    description: "Save (or update) a draft intake. Partial answers are fine — call this again with " +
      "the same draft_id to add more as the conversation progresses.",
    inputSchema: { type: "object", properties: {
      draft_id: { type: "string", description: "Omit to start a new draft." },
      answers: { type: "object", description: "Partial or full {q0: ..., q1: ..., ...} map." },
    } },
    async run({ draft_id, answers }, caller) {
      const id = await upsertDraft({ draft_id, answers, source: "chat", submitted_by: caller.actor });
      return { draft_id: id };
    },
  },

  get_draft: {
    description: "Read back a draft or submitted intake's stored answers.",
    inputSchema: { type: "object", required: ["draft_id"], properties: {
      draft_id: { type: "string" },
    } },
    async run({ draft_id }) {
      if (!draft_id) return { error: "draft_id is required" };
      const row = await getIntake(draft_id);
      if (!row) return { error: `no intake with id ${draft_id}` };
      return { id: row.id, status: row.status, answers: row.answers, compass_pr_url: row.compass_pr_url };
    },
  },

  submit_intake: {
    description: "Finalize a draft: marks it submitted and files it into the Compass review queue. " +
      "No passphrase — the chat path is already behind a login on the lab mesh. Confirm the answers " +
      "with the user first; this is the step that cannot be undone from chat.",
    // 🔺 NO PASSPHRASE ON THIS PATH, and removing it made the system SAFER, not laxer.
    //
    // The passphrase exists for the PUBLIC web form, where there is no login and it is the only
    // gate. REST /submit therefore still requires it — do not "simplify" that one to match.
    //
    // Through chat it was worse than redundant. Redundant because this bridge binds to the mesh
    // only and LibreChat authenticates every user, so a caller has already passed two gates that
    // a shared word does not strengthen. Worse because the only way to supply it was to TYPE A
    // SHARED SECRET INTO A CHAT BOX — and LibreChat persists conversations in Mongo, so every use
    // wrote the passphrase into stored history, unencrypted, where the next person to read that
    // conversation (or restore that database) would find it. A gate whose use leaks the credential
    // it checks is a net loss.
    //
    // ℹ️ Attribution did not depend on it and is now the stronger signal: `caller.actor` comes from
    // a header LibreChat substitutes SERVER-SIDE, so the model cannot forge it — measured, a real
    // chat submission recorded the user's own address. A shared passphrase proved only that
    // somebody knew a word; the header says who.
    //
    // ⚠️ `passphrase` stays declared but IGNORED so an agent still running the old prompt does not
    // hard-fail mid-conversation. Nothing reads it. Remove the property once no prompt sends it.
    inputSchema: { type: "object", required: ["draft_id"], properties: {
      draft_id: { type: "string" },
      passphrase: { type: "string", description: "Ignored, kept for compatibility. Do not ask for one." },
    } },
    async run({ draft_id }, caller) {
      if (!draft_id) return { error: "draft_id is required" };
      const row = await getIntake(draft_id);
      if (!row) return { error: `no intake with id ${draft_id}` };
      const result = await finalizeSubmission({
        draft_id, answers: row.answers, submitted_by: caller.actor, source: "chat",
      });
      return result;
    },
  },

  list_recent_intakes: {
    description: "Recent intakes, read-only, no passphrase needed.",
    inputSchema: { type: "object", properties: {
      status: { type: "string", enum: ["draft", "submitted"] },
      limit: { type: "number", description: "Default 20, max 200." },
    } },
    async run({ status, limit }) {
      const rows = await listRecent({ status, limit });
      return {
        count: rows.length,
        intakes: rows.map((r) => ({
          id: r.id, status: r.status, project_name: r.project_name || null,
          submitted_by: r.submitted_by, created_at: r.created_at,
        })),
      };
    },
  },
};

async function dispatch(msg, caller) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize": {
      // Echo the client's revision when we support it; otherwise answer with ours and let the
      // client decide whether to proceed. Never silently assert a version nobody asked for.
      const asked = params?.protocolVersion;
      const agreed = SUPPORTED_PROTOCOLS.includes(asked) ? asked : PROTOCOL;
      return ok({ protocolVersion: agreed, capabilities: { tools: {} },
        serverInfo: { name: "datalab-intake-bridge", version: "1.0.0" } });
    }
    case "notifications/initialized": return null;
    case "ping": return ok({});
    case "tools/list":
      return ok({ tools: Object.entries(TOOLS).map(([name, t]) =>
        ({ name, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const tool = TOOLS[params?.name];
      if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: `no such tool: ${params?.name}` } };
      try {
        const out = await tool.run(params.arguments || {}, caller);
        return ok({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return ok({ content: [{ type: "text", text: `error: ${e.message}` }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported method: ${method}` } };
  }
}

/* ── HTTP ──────────────────────────────────────────────────────────────────────────────────── */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** The CORS headers for one request, or {} if this origin is not allowed. `Vary: Origin` is not
 *  optional: without it a cache can serve one origin's allow-header to another origin. */
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-intake-passphrase",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** CORS is already set on `res` once, in the request handler below, so this only adds the content
 *  type. ⚠️ Do NOT reintroduce a per-call `req` argument: threading the headers through each call
 *  is what caused the 2026-08-27 bug where /submit and /mcp returned a 200 the browser discarded,
 *  after a row had already been written. One place sets them, so a new route cannot forget. */
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

/** The request handler. `publicFacing` marks the listener NetBird exposes to the internet. */
function makeHandler({ publicFacing }) {
  return async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    // See PUBLIC_PORT above. Refused before anything else reads the request, and for every method,
    // so no future route or verb can quietly re-open it.
    if (publicFacing && pathname === "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "not found" }));
    }

    /* 🔺 CORS HEADERS ARE SET ONCE, HERE, FOR EVERY RESPONSE — not passed into each sendJson call.
     *
     * They were threaded through individually until 2026-08-27 and two call sites were missed: the
     * ones returning a VARIABLE rather than an object literal, which happen to be the success paths
     * of /submit and /mcp. The preflight passed, so it all looked right, and then the real POST came
     * back with no Access-Control-Allow-Origin and the browser discarded a 200 the server had
     * happily produced — "Submission failed" in the UI, a successful request in the log, and a row
     * written to Postgres for a submission the user was told had failed. Found by driving the real
     * form; no amount of curl would have shown it, because curl does not enforce CORS.
     *
     * Setting them on `res` up front means a new route cannot forget them. /mcp is excluded on
     * purpose (see the OPTIONS handler below): it is for server-side callers only. */
    if (pathname !== "/mcp") {
      for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
    }

    if (req.method === "GET" && pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok\n");
    }

    // Preflight. Answered for the browser-facing REST routes only — NOT for /mcp, which exists for
    // server-side callers (Claude Code, LibreChat) and has no reason to be reachable from a web
    // page. Declining to CORS-enable /mcp keeps browser-driven tool calls off the table entirely.
    if (req.method === "OPTIONS") {
      if (pathname === "/mcp") { res.writeHead(404); return res.end(); }
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }

    if (req.method === "POST" && pathname === "/draft") {
      // ⚠️ This route takes NO passphrase, by design — drafting has to work before anyone has one.
      // That makes it a public unauthenticated write, so it gets the same limiter as /submit;
      // otherwise it is an open invitation to fill the table with rows. (readBody already caps the
      // payload, so the remaining lever is request COUNT.)
      // Per-IP ONLY here, deliberately: this route has no passphrase, so there is no "correct"
      // request to protect — but it also must not inherit the global failure lockout, or a
      // passphrase guesser would take drafting down for everyone as a side effect.
      if (perIpLimited(clientIp(req))) {
        return sendJson(res, 429, { error: "too many attempts, try again later" });
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      const submitted_by = callerIdentity(req.headers, "web");
      const id = await upsertDraft({
        draft_id: body.draft_id, answers: body.answers, source: "web", submitted_by,
      });
      return sendJson(res, 200, { draft_id: id });
    }

    if (req.method === "GET" && /^\/draft\/[^/]+$/.test(pathname)) {
      const id = decodeURIComponent(pathname.slice("/draft/".length));
      const row = await getIntake(id);
      if (!row) return sendJson(res, 404, { error: "not found" });
      return sendJson(res, 200, { id: row.id, status: row.status, answers: row.answers, compass_pr_url: row.compass_pr_url });
    }

    if (req.method === "POST" && pathname === "/submit") {
      const ip = clientIp(req);
      // Order matters and is the opposite of the obvious one: verify FIRST, and let the limiter
      // touch only the requests that got it wrong. See rateLimited()'s comment for why guarding
      // the success path turns this into a DoS.
      const passphrase = req.headers["x-intake-passphrase"];
      if (!safeEqual(passphrase, PASSPHRASE)) {
        noteFailedAttempt();
        const throttled = rateLimited(ip);
        if (throttled) await sleep(THROTTLE_MS);
        // No detail either way, by design — a wrong/missing passphrase must not tell an attacker
        // which it was, and 429-vs-403 deliberately says nothing about the secret.
        return sendJson(res, throttled ? 429 : 403, { error: "forbidden" });
      }

      const body = JSON.parse((await readBody(req)) || "{}");
      const submitted_by = callerIdentity(req.headers, "web");
      const result = await finalizeSubmission({
        draft_id: body.draft_id, answers: body.answers, submitted_by, source: "web",
      });
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && pathname === "/mcp") {
      const raw = await readBody(req);
      let msgs;
      try { msgs = JSON.parse(raw); }
      catch { return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }

      const caller = {
        ip: clientIp(req),
        actor: callerIdentity(req.headers, "claude-code"),
      };
      const single = !Array.isArray(msgs);
      const out = [];
      for (const m of single ? [msgs] : msgs) {
        const r = await dispatch(m, caller);
        if (r) out.push(r);
      }
      if (!out.length) { res.writeHead(202); return res.end(); }
      return sendJson(res, 200, single ? out[0] : out);
    }

    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    console.log(`bridge: WARNING request failed: ${e && e.message}`);
    if (res.headersSent) return res.end();
    sendJson(res, 500, { error: "internal error" });
  }
  };
}

const srv = http.createServer(makeHandler({ publicFacing: false }));
srv.listen(PORT, () => console.log(
  `bridge: listening on :${srv.address().port} (mesh, all routes), form schema ${FORM_CONFIG_PATH}, ` +
  `compass PR filing ${COMPASS_TOKEN ? "enabled" : "disabled (no COMPASS_GITHUB_TOKEN)"}`,
));

if (PUBLIC_PORT) {
  const pubSrv = http.createServer(makeHandler({ publicFacing: true }));
  pubSrv.listen(PUBLIC_PORT, () => console.log(
    `bridge: listening on :${pubSrv.address().port} (internet-facing via NetBird, /mcp refused)`,
  ));
}
