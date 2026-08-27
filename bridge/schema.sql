-- Intake bridge — Postgres schema.
--
-- Applied BY HAND by a human when the `intake` database is created (see the
-- central-database runbook / add-app-db.sh — this repo has no auto-migration on boot,
-- deliberately: `psql "$INTAKE_DATABASE_URL" -f bridge/schema.sql`).
--
-- JSONB answers so a formConfig.json change (a question added/removed/reworded) never needs a
-- migration here — the schema only needs to change if the shape of an INTAKE itself changes.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS intakes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('draft','submitted')) DEFAULT 'draft',
  source TEXT NOT NULL CHECK (source IN ('web','chat')) DEFAULT 'web',
  submitted_by TEXT,
  answers JSONB NOT NULL DEFAULT '{}',
  project_slug TEXT,
  compass_pr_url TEXT
);

CREATE INDEX IF NOT EXISTS intakes_status_idx ON intakes (status);
CREATE INDEX IF NOT EXISTS intakes_created_at_idx ON intakes (created_at DESC);
