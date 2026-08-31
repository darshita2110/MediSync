-- ============================================================
-- MediSync — Database Schema
-- PostgreSQL 13+
--
-- Run once against your database, e.g.:
--   psql "$DATABASE_URL" -f schema.sql
-- ============================================================

-- gen_random_uuid() is built into Postgres 13+. If you're on an
-- older version, uncomment the next line to enable it via pgcrypto:
-- CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ------------------------------------------------------------
-- USERS
-- The auth backbone. Everything else references a user.
-- ------------------------------------------------------------
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,           -- bcrypt/argon2 hash, never a raw password
    name          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ------------------------------------------------------------
-- MEDICATIONS
-- One row per drug a user is taking. openFDA fields let you
-- link a user's med to real drug data for the safety lookup.
-- ------------------------------------------------------------
CREATE TABLE medications (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,           -- brand name as the user knows it, e.g. "Advil"
    generic_name  TEXT,                    -- from openFDA, e.g. "ibuprofen"
    strength      TEXT,                    -- e.g. "500 mg"
    form          TEXT,                    -- e.g. "tablet", "capsule"
    rxcui         TEXT,                    -- RxNorm identifier (from openFDA), for lookups
    ndc           TEXT,                    -- National Drug Code (from openFDA)
    notes         TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,  -- FALSE = stopped, but keep history
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_medications_user_id ON medications(user_id);


-- ------------------------------------------------------------
-- SCHEDULES
-- The reminders engine. A medication can have several schedules
-- (e.g. 8am and 8pm). days_of_week is an array of ints where
-- 0 = Sunday ... 6 = Saturday. An empty/NULL array means "every day".
-- ------------------------------------------------------------
CREATE TABLE schedules (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    medication_id UUID NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
    dose_amount   TEXT NOT NULL DEFAULT '1',  -- e.g. "1 tablet", "2 puffs"
    time_of_day   TIME NOT NULL,              -- when the reminder fires, e.g. 08:00
    days_of_week  SMALLINT[] DEFAULT '{}',    -- {1,3,5} = Mon/Wed/Fri; {} = daily
    start_date    DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date      DATE,                       -- NULL = ongoing
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_schedules_medication_id ON schedules(medication_id);


-- ------------------------------------------------------------
-- DOSE LOGS
-- Adherence tracking. Each scheduled dose becomes a log entry.
-- This is what powers "you've taken 90% of doses this week".
-- ------------------------------------------------------------
CREATE TYPE dose_status AS ENUM ('taken', 'missed', 'skipped');

CREATE TABLE dose_logs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id   UUID NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- denormalized for fast per-user queries
    scheduled_for TIMESTAMPTZ NOT NULL,       -- the exact moment this dose was due
    status        dose_status NOT NULL DEFAULT 'missed',
    taken_at      TIMESTAMPTZ,                -- when the user actually marked it taken
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dose_logs_user_id ON dose_logs(user_id);
CREATE INDEX idx_dose_logs_schedule_id ON dose_logs(schedule_id);
CREATE INDEX idx_dose_logs_scheduled_for ON dose_logs(scheduled_for);


-- ------------------------------------------------------------
-- DRUG INFO CACHE  (OPTIONAL — add when openFDA is wired up)
-- Caches openFDA responses so you don't refetch the same drug.
-- Key on whatever you query openFDA by (e.g. rxcui or drug name).
-- ------------------------------------------------------------
CREATE TABLE drug_info_cache (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lookup_key   TEXT NOT NULL UNIQUE,       -- e.g. rxcui or normalized drug name
    data         JSONB NOT NULL,             -- the raw openFDA response
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_drug_info_cache_lookup_key ON drug_info_cache(lookup_key);