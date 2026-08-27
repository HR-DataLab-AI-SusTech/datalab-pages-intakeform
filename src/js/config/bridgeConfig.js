// Base URL for the intake bridge (bridge/server.js — REST + MCP backend for this form).
//
// This repo has no build step (native ES modules only), so there is no env-var injection at
// build/deploy time — this constant is the one place to edit. Production value below is the
// intended public hostname, decided but not yet live; point it at
// `http://localhost:3458` for local dev against `docker compose up` in bridge/.
export const BRIDGE_BASE_URL = 'https://intake.twinhub.nl';
