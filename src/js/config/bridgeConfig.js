// Base URL for the intake bridge (bridge/server.js — REST + MCP backend for this form).
//
// This repo has no build step (native ES modules only), so there is no env-var injection at
// build/deploy time — this constant is the one place to edit. Point it at `http://localhost:3458`
// for local dev against `docker compose --profile dev up` (see bridge/README.md).
export const BRIDGE_BASE_URL = 'https://intake.twinhub.nl';

/* ✅ SUBMIT IS ON since 2026-08-28. Three things had to be true, and all three were measured.
 *
 * 1. `intake.twinhub.nl` resolves AND is published through NetBird's reverse proxy — it is, and as
 *    of 2026-08-28 it is a PUBLIC service rather than a mesh-only one. That change is deliberate
 *    and is what makes this flag meaningful: a browser with no NetBird client could never reach a
 *    mesh-only endpoint, so enabling Submit against one would have shipped a button that failed
 *    for exactly the people it is for.
 * 2. The bridge answers `GET /healthz` on it from a machine that is NOT on the mesh.
 * 3. `https://hr-datalab-ai-sustech.github.io` is in the bridge's INTAKE_ALLOWED_ORIGINS, so the
 *    browser's CORS preflight succeeds — verified against the live endpoint, not assumed.
 *
 * 🔺 WHAT PUBLISHING DID *NOT* PUT ON THE INTERNET, because that was the real work. `/mcp` used to
 * share this port, and it carries `submit_intake` (no passphrase — it relied on mesh membership)
 * and `list_recent_intakes` (unfiltered, every user's intakes). The bridge now runs TWO listeners:
 * the mesh one keeps every route, and the published one serves the browser REST routes and 404s
 * `/mcp`. See BRIDGE_PUBLIC_PORT in `bridge/server.js`.
 *
 * ⚠️ The shared passphrase is now the whole perimeter on `POST /submit`, where before it sat behind
 * mesh membership as well. That is ADR-0017's original design, restored — but it means a leaked
 * passphrase is a leaked write endpoint. Rotate it if it is ever typed anywhere it can be stored.
 *
 * To turn Submit off again: set this to false. FLIP IT, DON'T DELETE IT — the form then renders a
 * short honest note where the button was, and keeps working as download-only.
 */
export const SUBMIT_ENABLED = true;
