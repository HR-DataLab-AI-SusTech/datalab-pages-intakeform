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
const DATABASE_URL = process.env.INTAKE_DATABASE_URL || "";
const PASSPHRASE = process.env.INTAKE_SUBMIT_PASSPHRASE || "";
const COMPASS_TOKEN = process.env.COMPASS_GITHUB_TOKEN || "";
const FORM_CONFIG_PATH = process.env.FORM_CONFIG_PATH || "/app/formConfig.json";
const COMPASS_REPO = "HR-DataLab-AI-SusTech/compass";
const COMPASS_API = "https://api.github.com";

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

function rateLimited(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// Sweep expired entries occasionally so a long-lived process does not accumulate one entry per IP
// forever. Not correctness-critical — just housekeeping.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) if (now > entry.resetAt) rateLimitMap.delete(ip);
}, 30 * 60 * 1000).unref();

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
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
function readFormConfig() {
  const raw = fs.readFileSync(FORM_CONFIG_PATH, "utf8");
  return JSON.parse(raw);
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
    try { fields = schemaFields(readFormConfig()); }
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
        `automatically by the datalab-intake-form bridge when the submitter entered the shared passphrase.`,
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

const PROTOCOL = "2025-06-18";

const TOOLS = {
  get_intake_schema: {
    description: "The current intake form schema (formConfig.json's pages/fields) — the same " +
      "questions the web form asks. Read this before asking the user anything, so questions never drift.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      return readFormConfig();
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
      "Requires the shared passphrase — same gate as the web form's Submit button.",
    inputSchema: { type: "object", required: ["draft_id", "passphrase"], properties: {
      draft_id: { type: "string" },
      passphrase: { type: "string" },
    } },
    async run({ draft_id, passphrase }, caller) {
      if (!draft_id) return { error: "draft_id is required" };
      if (!safeEqual(passphrase, PASSPHRASE)) return { error: "forbidden" };
      if (rateLimited(caller.ip)) return { error: "too many attempts, try again later" };
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
    case "initialize":
      return ok({ protocolVersion: PROTOCOL, capabilities: { tools: {} },
        serverInfo: { name: "datalab-intake-bridge", version: "1.0.0" } });
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

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const srv = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok\n");
    }

    if (req.method === "POST" && pathname === "/draft") {
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
      if (rateLimited(ip)) return sendJson(res, 429, { error: "too many attempts, try again later" });

      const passphrase = req.headers["x-intake-passphrase"];
      if (!safeEqual(passphrase, PASSPHRASE)) {
        // No detail, by design — a wrong/missing passphrase must not tell an attacker which it was.
        return sendJson(res, 403, { error: "forbidden" });
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
});

srv.listen(PORT, () => console.log(
  `bridge: listening on :${srv.address().port}, form schema ${FORM_CONFIG_PATH}, ` +
  `compass PR filing ${COMPASS_TOKEN ? "enabled" : "disabled (no COMPASS_GITHUB_TOKEN)"}`,
));
