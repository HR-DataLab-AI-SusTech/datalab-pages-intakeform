// Base URL for the intake bridge (bridge/server.js — REST + MCP backend for this form).
//
// This repo has no build step (native ES modules only), so there is no env-var injection at
// build/deploy time — this constant is the one place to edit. Point it at `http://localhost:3458`
// for local dev against `docker compose --profile dev up` (see bridge/README.md).
export const BRIDGE_BASE_URL = 'https://intake.twinhub.nl';

/* 🔺 THE SUBMIT BUTTON IS OFF UNTIL THE BACKEND IS ACTUALLY DEPLOYED. FLIP THIS, DON'T DELETE IT.
 *
 * This form is published to GitHub Pages the moment anything lands on `main`, but the bridge it
 * talks to is a container on PC-1 that is deployed separately and is NOT live yet. Shipping an
 * enabled Submit button before then puts a control on a PUBLIC page that cannot do anything: a
 * stakeholder fills in the whole form, presses it, and gets a network error with no explanation —
 * strictly worse than the download-only form they had before.
 *
 * With this false the form keeps working exactly as it always did (fill in → review → download
 * Markdown/CSV) and the submit section renders as a short, honest note instead of a dead button.
 *
 * ✅ TURN IT ON when all three are true — not before, and not one at a time:
 *   1. `intake.twinhub.nl` resolves AND is published through NetBird's reverse proxy
 *   2. the bridge answers `GET /healthz` on it from a machine that is NOT on the mesh
 *   3. that hostname is in the bridge's INTAKE_ALLOWED_ORIGINS, or the browser's CORS preflight
 *      fails and the button breaks in a way the server log will not even show you
 */
export const SUBMIT_ENABLED = false;
