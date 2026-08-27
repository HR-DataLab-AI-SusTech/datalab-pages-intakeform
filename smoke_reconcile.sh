#!/usr/bin/env bash
# Smoke test for the intake bridge, run by lab-reconcile AFTER a deploy that actually changed
# something — never on an idle tick (the reconciler is explicit about that; a smoke test that runs
# ~288 times a day is a smoke test somebody deletes).
#
# 🔺 IT ASSERTS A REQUEST WAS SERVED, NOT THAT A CONTAINER IS UP. That distinction is the whole
# point: this estate has already been bitten by a connectors container sitting `running` while every
# poll inside it failed, with the healthcheck reporting PASS throughout. `docker ps` is not health.
#
# Read-only by construction — /healthz and an MCP `tools/list`. It never calls tools/call, never
# posts a draft, and never submits, so running it cannot create rows or open a PR.
set -euo pipefail

PORT="${BRIDGE_PORT:-3458}"
BASE="http://127.0.0.1:${PORT}"
fail() { echo "smoke: FAIL — $*" >&2; exit 1; }

# 1. The container answers at all. Retried, because `compose up -d` returns before a fresh
#    container has finished booting, and a cold Node start plus a first Postgres connection is
#    comfortably slower than the reconciler's next line.
ok=0
for _ in $(seq 1 15); do
  if [ "$(curl -fsS -o /dev/null -w '%{http_code}' -m 3 "${BASE}/healthz" 2>/dev/null || true)" = "200" ]; then
    ok=1; break
  fi
  sleep 2
done
[ "$ok" = "1" ] || fail "no 200 from ${BASE}/healthz after ~30s"

# 2. The MCP surface is actually serving tools. A bridge that boots but advertises nothing is the
#    failure a chat user would meet as "the assistant has no tools", with nothing in any log.
tools="$(curl -fsS -m 5 -X POST "${BASE}/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' 2>/dev/null || true)"
case "$tools" in
  *submit_intake*) : ;;
  *) fail "tools/list did not advertise submit_intake (got: $(printf '%.120s' "${tools:-<empty>}"))" ;;
esac

# 3. The passphrase gate is closed. Deploying a public submit endpoint that accepts a wrong
#    passphrase would be worse than deploying nothing, so prove the refusal rather than assume it.
code="$(curl -fsS -o /dev/null -w '%{http_code}' -m 5 -X POST "${BASE}/submit" \
  -H 'content-type: application/json' \
  -H 'x-intake-passphrase: definitely-not-the-passphrase' \
  -d '{"answers":{}}' 2>/dev/null || echo "$?")"
# 403 = rejected outright. 429 = rejected AND throttled (the limiter had already tripped, e.g. this
# smoke test ran twice in a window). Both mean the gate held; anything else does not.
case "$code" in
  403|429) : ;;
  *) fail "a wrong passphrase returned HTTP ${code}, expected 403 (or 429 if throttled)" ;;
esac

echo "smoke: ok — healthz 200, tools/list advertises submit_intake, wrong passphrase refused (${code})"
