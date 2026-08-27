#!/usr/bin/env bash
# Install the Compass write token into env.sops — the last step between a submitted intake being
# SAVED and being FILED. Until this runs, submit_intake stores the answers and opens no PR, so
# nobody is notified; the bridge says so in its startup line and in the tool result.
#
#   ./bridge/set-compass-token.sh            # prompts, input hidden
#   pbpaste | ./bridge/set-compass-token.sh  # or pipe it
#
# 🔺 THE TOKEN IS NEVER AN ARGUMENT AND IS NEVER PRINTED. Passing a secret as argv puts it in the
# process list and in shell history; this reads stdin instead. Nothing here echoes the value, and
# `sops set` rewrites one key without rendering the other seven. What you see is pass/fail only.
#
# ⚠️ It PROVES the token before storing it. A token that cannot write is worse than none: the
# bridge would attempt a PR on every submit, fail, and fall back to the same silent
# saved-not-filed state — but now with an error nobody reads instead of an honest "no token".
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="HR-DataLab-AI-SusTech/compass"
die() { echo "ERROR: $*" >&2; exit 1; }

command -v sops >/dev/null || die "sops not installed"
command -v jq   >/dev/null || die "jq not installed"
[ -f env.sops ] || die "env.sops not found — run this from the repo"

# macOS: the default age key path is not where sops looks. Harmless if already exported.
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"
[ -f "$SOPS_AGE_KEY_FILE" ] || die "no age key at $SOPS_AGE_KEY_FILE — sops cannot re-encrypt"

if [ -t 0 ]; then
  printf 'Compass token (input hidden): ' >&2
  IFS= read -rs TOKEN
  printf '\n' >&2
else
  # `|| true` because read returns non-zero at EOF — without it `set -e` kills the script before
  # the check below and an empty pipe fails silently, which reads as "it worked".
  IFS= read -r TOKEN || true
fi
[ -n "${TOKEN:-}" ] || die "no token on stdin"

# ── Prove it, before storing it ───────────────────────────────────────────────────────────────
# `permissions.push` is what the four calls in fileIntoCompass() need (create a ref, PUT two
# files, POST a pull). Reading it costs one request and no side effects — as opposed to finding
# out at 2am, inside a user's submit, that the token is read-only.
resp="$(curl -sS -m 20 -H "Authorization: Bearer $TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/$REPO" 2>/dev/null || true)"

# ⚠️ Never print $resp. An error body from a request that carried a credential can echo the
# request back — read only the fields, never the blob.
name="$(printf '%s' "$resp" | jq -r '.full_name // empty')"
push="$(printf '%s' "$resp" | jq -r '.permissions.push // false')"

[ -n "$name" ] || die "token cannot see $REPO (bad token, or the org blocks it for this repo)"
[ "$name" = "$REPO" ] || die "token resolved a different repo: $name"
[ "$push" = "true" ] || die "token can READ $REPO but not write to it — it needs contents:write
       and pull_requests:write. Storing a read-only token would make every submit attempt a PR,
       fail, and land back in saved-not-filed with a noisier failure. Not stored."

echo "  ✓ token verified: can write to $name"

# ── Store it ─────────────────────────────────────────────────────────────────────────────────
sops set --input-type dotenv --output-type dotenv env.sops \
  '["COMPASS_GITHUB_TOKEN"]' "$(jq -Rn --arg t "$TOKEN" '$t')" >/dev/null
unset TOKEN

enc="$(grep -c '^COMPASS_GITHUB_TOKEN=ENC\[' env.sops || true)"
[ "$enc" = "1" ] || die "env.sops does not show COMPASS_GITHUB_TOKEN as encrypted — check it"
plain="$(grep -cE '^[A-Z_]+=[^E]' env.sops || true)"
[ "$plain" = "0" ] || die "$plain key(s) look unencrypted in env.sops — do NOT commit"

echo "  ✓ stored encrypted in env.sops ($(grep -c '^[A-Z_]*=ENC\[' env.sops) keys, 0 in the clear)"
cat <<'NEXT'

  Next, and none of it is automatic:
    git commit -am 'compass token: enable review-queue PR filing' && git push
    ssh datalab-ubuntu-1 'cd ~/intake-bridge && git pull --ff-only && docker compose up -d --build'

  Then confirm the bridge agrees — its startup line is the honest one:
    ssh datalab-ubuntu-1 'docker logs --tail 1 intake-bridge-bridge-1'
    #   want: "compass PR filing enabled"   (not "disabled (no COMPASS_GITHUB_TOKEN)")
NEXT
