#!/usr/bin/env node
/**
 * MCP conformance probe — runs against a LIVE bridge over HTTP.
 *
 * 🔺 WHY THIS EXISTS. Two bridges in this estate (compass-board's and the intake form's) implement
 * MCP-over-HTTP by hand rather than with @modelcontextprotocol/sdk. That is a deliberate choice —
 * zero dependencies, auditable, and proven in production — but it buys a specific risk: they share
 * one implementation and one pinned protocol revision, so a client that raises its required
 * revision breaks BOTH at once, and nothing would notice until someone opened a chat.
 *
 * This is the cheap half of that mitigation. It asserts the handshake and the envelope, which is
 * what a client actually depends on, without needing the SDK or a real database.
 *
 * Usage:
 *   node mcp-conformance.mjs http://127.0.0.1:3458/mcp
 *   node mcp-conformance.mjs http://100.104.254.98:3457/mcp     # compass-board, over the mesh
 *
 * Exit code 0 = conformant, 1 = at least one property failed. Safe to run against production:
 * every call below is a READ (initialize / ping / tools/list). It never calls tools/call, so it
 * cannot create, submit, or delete anything.
 */

const endpoint = process.argv[2];
if (!endpoint) {
  console.error("usage: node mcp-conformance.mjs <url-of-/mcp>");
  process.exit(2);
}

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
};

async function rpc(body, { raw = false } = {}) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* left null on purpose */ }
  return { status: res.status, json, text };
}

console.log(`\nMCP conformance: ${endpoint}\n`);

/* ── 1. initialize, and the negotiation that has to actually negotiate ─────────────────────── */
const init = await rpc({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "conformance", version: "0" } },
});
check("initialize returns 200", init.status === 200, `got ${init.status}`);
check("initialize echoes jsonrpc 2.0", init.json?.jsonrpc === "2.0");
check("initialize preserves the request id", init.json?.id === 1);
check("initialize reports a protocolVersion", typeof init.json?.result?.protocolVersion === "string");
check("initialize declares a tools capability", !!init.json?.result?.capabilities?.tools);
check("initialize names the server", !!init.json?.result?.serverInfo?.name);

// The property that actually matters, and the one that was broken: a supported revision the client
// asked for must come back UNCHANGED, not replaced by the server's favourite.
check(
  "a supported revision is echoed back, not overridden",
  init.json?.result?.protocolVersion === "2025-06-18",
  `asked 2025-06-18, got ${init.json?.result?.protocolVersion}`,
);

const older = await rpc({
  jsonrpc: "2.0", id: 2, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "0" } },
});
check(
  "an older Streamable-HTTP revision is also honoured",
  older.json?.result?.protocolVersion === "2025-03-26",
  `asked 2025-03-26, got ${older.json?.result?.protocolVersion}`,
);

const bogus = await rpc({
  jsonrpc: "2.0", id: 3, method: "initialize",
  params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "c", version: "0" } },
});
check(
  "an UNsupported revision falls back to one the server implements",
  typeof bogus.json?.result?.protocolVersion === "string" && bogus.json.result.protocolVersion !== "1999-01-01",
  `got ${bogus.json?.result?.protocolVersion}`,
);

/* ── 2. the notification rule: no id ⇒ no response body ────────────────────────────────────── */
const note = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
check(
  "a notification gets 202 and an empty body, never a result",
  note.status === 202 && !note.text.trim(),
  `status ${note.status}, body ${JSON.stringify(note.text.slice(0, 60))}`,
);

/* ── 3. ping ───────────────────────────────────────────────────────────────────────────────── */
const ping = await rpc({ jsonrpc: "2.0", id: 4, method: "ping" });
check("ping answers with an empty result object", ping.json?.result && !Object.keys(ping.json.result).length);

/* ── 4. tools/list — the shape a client builds its tool menu from ──────────────────────────── */
const tools = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list" });
const list = tools.json?.result?.tools;
check("tools/list returns an array", Array.isArray(list));
check("at least one tool is advertised", Array.isArray(list) && list.length > 0);
check(
  "every tool has name + description + an object inputSchema",
  Array.isArray(list) && list.every((t) => t.name && t.description && t.inputSchema?.type === "object"),
  Array.isArray(list) ? `offenders: ${list.filter((t) => !(t.name && t.description && t.inputSchema?.type === "object")).map((t) => t.name || "?").join(",")}` : "",
);
if (Array.isArray(list)) console.log(`       tools: ${list.map((t) => t.name).join(", ")}`);

/* ── 5. error handling ─────────────────────────────────────────────────────────────────────── */
const bad = await rpc("{not json", { raw: true });
check("malformed JSON gives a -32700 parse error", bad.json?.error?.code === -32700, `got ${JSON.stringify(bad.json?.error)}`);

const nomethod = await rpc({ jsonrpc: "2.0", id: 6, method: "no/such/method" });
check("an unknown method gives -32601", nomethod.json?.error?.code === -32601, `got ${JSON.stringify(nomethod.json?.error)}`);

const notool = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "definitely-not-a-tool", arguments: {} } });
check("an unknown tool errors rather than 500ing", !!notool.json?.error || notool.json?.result?.isError, `got ${JSON.stringify(notool.json)?.slice(0, 120)}`);

/* ── 6. batch — JSON-RPC 2.0 allows an array, and a client may send one ────────────────────── */
const batch = await rpc([
  { jsonrpc: "2.0", id: 8, method: "ping" },
  { jsonrpc: "2.0", id: 9, method: "tools/list" },
]);
check(
  "a batch of 2 returns an array of 2, ids preserved",
  Array.isArray(batch.json) && batch.json.length === 2 && batch.json.map((r) => r.id).join() === "8,9",
  `got ${JSON.stringify(batch.json)?.slice(0, 120)}`,
);

console.log(`\n${failed ? `FAILED — ${failed} propert${failed === 1 ? "y" : "ies"}` : "all properties hold"}\n`);
process.exit(failed ? 1 : 0);
