# The intake bridge

REST + MCP backend for the intake form. Persists submissions to Postgres, and — when it has a
token — files each one into a review queue in Compass by opening a PR.

- **What it is and why**: [`projects/intake-form/`](https://github.com/HR-DataLab-AI-SusTech/compass/blob/main/projects/intake-form/README.md) in Compass.
- **The two decisions it is built on** (public + passphrase-gated; a scoped bot write to Compass):
  [ADR-0017](https://github.com/HR-DataLab-AI-SusTech/compass/blob/main/knowledge/decisions/0017-intake-form-public-submit-and-a-scoped-bot-write-to-compass.md).

## Try it locally — no lab credentials, no mesh, nothing to provision

Everything below runs on a laptop against a throwaway Postgres. It never touches the real database
and never opens a real PR (no `COMPASS_GITHUB_TOKEN` ⇒ that step is skipped and says so).

```sh
# 1. an env file for local use
cp bridge/.env.example bridge/.env

# 2. point it at the dev database and let the browser talk to the local form.
#    (the defaults in .env.example are the PRODUCTION values — these two must change)
cat >> bridge/.env <<'EOF'
INTAKE_DATABASE_URL=postgres://intake:devonly@postgres-dev:5432/intake
INTAKE_SUBMIT_PASSPHRASE=letmein
INTAKE_ALLOWED_ORIGINS=http://127.0.0.1:8080
FORM_CONFIG_URL=file-does-not-matter-locally    # fetch fails, falls back to the mount, logs why
EOF

# 3. up. MESH_IP is required by the compose file; locally it is just a bind address.
MESH_IP=127.0.0.1 docker compose --profile dev up --build
```

Then:

| | |
| --- | --- |
| The form | <http://127.0.0.1:8080> |
| Bridge health | `curl -s localhost:3458/healthz` → `ok` |

**Fill the form in and press Submit** with passphrase `letmein`. Then look at the row it wrote:

```sh
docker compose exec postgres-dev psql -U intake -d intake \
  -c "select id, status, source, submitted_by, answers->>'q0' as project, compass_pr_url from intakes;"
```

### The things worth actually checking

```sh
# a wrong passphrase is 403 with no detail — never "wrong length" or "no such user"
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3458/submit \
  -H 'content-type: application/json' -H 'x-intake-passphrase: nope' -d '{"answers":{}}'

# the CORS preflight the browser sends before every submit. Without the Access-Control-Allow-*
# headers in this response, the real request never leaves the page — which is exactly the bug
# this file's first reviewer found, and it produced an EMPTY server log, not an error.
curl -s -D- -o /dev/null -X OPTIONS localhost:3458/submit \
  -H 'Origin: http://127.0.0.1:8080' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-intake-passphrase'

# an origin that is not on the allowlist gets NO allow-origin header back
curl -s -D- -o /dev/null -X OPTIONS localhost:3458/submit -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: POST' | grep -i 'access-control-allow-origin' || echo 'correctly absent'

# the MCP surface: the five tools, exactly as a chat agent or Claude Code sees them
curl -s -X POST localhost:3458/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -m json.tool | grep '"name"'

# /mcp is deliberately NOT CORS-enabled — it exists for server-side callers, so a web page
# must not be able to reach it. This is a 404, on purpose.
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS localhost:3458/mcp
```

## Routes

| Route | Auth | Notes |
| --- | --- | --- |
| `POST /draft` | none | Drafting must work before anyone has a passphrase. Rate-limited anyway — it is a public unauthenticated write. |
| `GET /draft/:id` | none | Resume. Used by the chat agent; the **web form does not need it** — it already survives a refresh via `sessionStorage`. |
| `POST /submit` | `X-Intake-Passphrase` | Finalises, and files into Compass if a token is configured. |
| `GET /healthz` | none | For the container healthcheck. |
| `POST /mcp` | none¹ | MCP JSON-RPC. `get_intake_schema`, `save_draft`, `get_draft`, `submit_intake` (takes the passphrase), `list_recent_intakes`. |

¹ Mesh-bound, and not published publicly — reachability *is* the boundary, same as
[`compass-board`](https://github.com/HR-DataLab-AI-SusTech/compass-board)'s bridge. `submit_intake`
still requires the passphrase.

## Two things not to "simplify" later

🔺 **The global failed-attempt counter is the real brute-force control, not the per-IP one.**
`X-Forwarded-For` is client-supplied and this server cannot validate it, so per-IP bucketing is
best-effort UX only. Deleting the global counter because per-IP looks sufficient reopens unlimited
guessing against the single shared passphrase — which is the *only* authentication this endpoint
has. Deleting the per-IP one instead is harmless.

🔺 **The startup guard that refuses an empty `INTAKE_SUBMIT_PASSPHRASE` is load-bearing.** With no
passphrase set, a request that sends no passphrase would otherwise *match*. Do not downgrade it to
a warning.

ℹ️ **The mounted `formConfig.json` is a fallback, not the source of truth.** GitHub Pages serves the
form from `main`; this container is deployed from an immutable pinned sha. `getFormConfig()`
therefore prefers the live published schema, so the chat agent cannot drift into asking a different
set of questions than the web form shows.
