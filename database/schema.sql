-- ============================================================
-- MediSync — Database Schema (v2, matches the project spec)
-- PostgreSQL 13+
--
-- Run:  psql "$DATABASE_URL" -f schema.sql
--
-- NOTE: this file DROPS and recreates everything, so it wipes data.
-- That's fine during early development while the model is changing.
-- Once you have real data you care about, switch to incremental
-- migration files instead of re-running this.
-- ============================================================

-- --- Clean slate (drop in reverse dependency order) ---------
DROP TABLE IF EXISTS conflicts          CASCADE;
DROP TABLE IF EXISTS dose_events         CASCADE;
DROP TABLE IF EXISTS schedules           CASCADE;
DROP TABLE IF EXISTS prescription_items  CASCADE;
DROP TABLE IF EXISTS prescriptions       CASCADE;
DROP TABLE IF EXISTS prescribers         CASCADE;
DROP TABLE IF EXISTS audit_log           CASCADE;
DROP TABLE IF EXISTS patient_access      CASCADE;
DROP TABLE IF EXISTS patients            CASCADE;
DROP TABLE IF EXISTS users               CASCADE;

DROP TYPE IF EXISTS access_role     CASCADE;
DROP TYPE IF EXISTS access_status   CASCADE;
DROP TYPE IF EXISTS item_status     CASCADE;
DROP TYPE IF EXISTS dose_status     CASCADE;
DROP TYPE IF EXISTS conflict_status CASCADE;

-- gen_random_uuid() is built into Postgres 13+.
-- CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- only if on older PG


-- ============================================================
-- STEP 2 tables — accounts, patients, access, audit
-- ============================================================

-- USERS — login details. A user is a *person with an account*
-- (a patient, a daughter, a helper). Not the same as a patient.
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- PATIENTS — who the medicines belong to. A patient may or may not
-- have their own user login; caregivers reach them via patient_access.
CREATE TABLE patients (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name     TEXT NOT NULL,
    timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',  -- doses are timezone-sensitive
    date_of_birth DATE,
    created_by    UUID NOT NULL REFERENCES users(id),    -- who set up this patient record
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Access roles, per your doc's four levels.
CREATE TYPE access_role   AS ENUM ('owner', 'family_admin', 'helper', 'viewer');
CREATE TYPE access_status AS ENUM ('pending', 'accepted');

-- PATIENT_ACCESS — who can see a patient, at what level, who invited them.
-- Nobody is added without an invite they accept (status starts 'pending').
CREATE TABLE patient_access (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id  UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    role        access_role   NOT NULL,
    status      access_status NOT NULL DEFAULT 'pending',
    invited_by  UUID REFERENCES users(id),             -- NULL for the original owner
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at TIMESTAMPTZ,
    UNIQUE (patient_id, user_id)                        -- one access row per person per patient
);

CREATE INDEX idx_patient_access_patient ON patient_access(patient_id);
CREATE INDEX idx_patient_access_user    ON patient_access(user_id);

-- AUDIT_LOG — every action, by whom, when. Health data shared between
-- people needs a record of who did what. High-volume, so bigserial.
CREATE TABLE audit_log (
    id            BIGSERIAL PRIMARY KEY,
    patient_id    UUID REFERENCES patients(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES users(id),
    action        TEXT NOT NULL,          -- e.g. 'dose.confirmed', 'access.invited'
    details       JSONB,                  -- flexible per-action context
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_patient ON audit_log(patient_id);


-- ============================================================
-- STEP 3 tables — prescribers, prescriptions, items
-- ============================================================

-- PRESCRIBERS — the doctors. Tracked per patient.
CREATE TABLE prescribers (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    specialty  TEXT,                       -- 'cardiologist', 'endocrinologist', ...
    clinic     TEXT,
    phone      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_prescribers_patient ON prescribers(patient_id);

-- PRESCRIPTIONS — a single visit: which doctor, which date, optional photo.
CREATE TABLE prescriptions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id    UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    prescriber_id UUID REFERENCES prescribers(id) ON DELETE SET NULL,
    visit_date    DATE NOT NULL,
    photo_url     TEXT,                     -- for the later "photograph the slip" feature
    notes         TEXT,
    created_by    UUID NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_prescriptions_patient ON prescriptions(patient_id);

-- PRESCRIPTION_ITEMS — one medicine on a prescription. This is the heart
-- of reconciliation: start/end dates + what it replaced let you answer
-- "what is she actually supposed to be taking right now".
CREATE TYPE item_status AS ENUM ('active', 'stopped', 'completed');

CREATE TABLE prescription_items (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prescription_id  UUID NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
    patient_id       UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,  -- denormalized: "active items for patient" is a hot query
    raw_text         TEXT NOT NULL,          -- what the user typed, e.g. "Telmikind 40"
    brand_name       TEXT,                   -- parsed brand, e.g. "Telmikind"
    ingredient       TEXT,                   -- resolved active ingredient, e.g. "telmisartan" (NULL until Level 2+)
    strength         TEXT,                   -- "40 mg"
    dose_amount      TEXT NOT NULL DEFAULT '1',  -- "1 tablet"
    frequency        TEXT,                   -- "once daily" (free text for now)
    start_date       DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date         DATE,                   -- NULL = ongoing
    replaces_item_id UUID REFERENCES prescription_items(id) ON DELETE SET NULL,  -- the item this supersedes
    status           item_status NOT NULL DEFAULT 'active',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_items_patient    ON prescription_items(patient_id);
CREATE INDEX idx_items_ingredient ON prescription_items(ingredient);


-- ============================================================
-- STEP 5 tables — schedules and actual doses
-- ============================================================

-- SCHEDULES — the repeating rule (8am and 8pm, which days).
-- days_of_week: {1,3,5} = Mon/Wed/Fri; {} = every day (0=Sun..6=Sat).
CREATE TABLE schedules (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prescription_item_id UUID NOT NULL REFERENCES prescription_items(id) ON DELETE CASCADE,
    patient_id           UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    time_of_day          TIME NOT NULL,
    days_of_week         SMALLINT[] NOT NULL DEFAULT '{}',
    start_date           DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date             DATE,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_schedules_item    ON schedules(prescription_item_id);
CREATE INDEX idx_schedules_patient ON schedules(patient_id);

-- DOSE_EVENTS — one row per actual dose, with who confirmed it and when.
-- Kept separate from schedules so adherence history survives (a single
-- overwritten "taken" flag would lose it).
CREATE TYPE dose_status AS ENUM ('pending', 'taken', 'missed', 'skipped');

CREATE TABLE dose_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id   UUID NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    patient_id    UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    scheduled_for TIMESTAMPTZ NOT NULL,      -- the exact moment this dose was due
    status        dose_status NOT NULL DEFAULT 'pending',
    confirmed_by  UUID REFERENCES users(id), -- who tapped "Taken"
    confirmed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- This constraint IS your "two people, one dose" solution:
    -- the first write for a (schedule, time) wins; the second hits this
    -- and you show "already confirmed by ..." instead of a duplicate.
    UNIQUE (schedule_id, scheduled_for)
);

CREATE INDEX idx_dose_events_patient   ON dose_events(patient_id);
CREATE INDEX idx_dose_events_scheduled ON dose_events(scheduled_for);


-- ============================================================
-- STEP 4 table — conflicts
-- ============================================================

-- CONFLICTS — what the reconciliation check flagged, which items were
-- involved, and whether it's been sorted out. Level 1 fills this from
-- day one; levels 2-4 add to it later.
CREATE TYPE conflict_status AS ENUM ('open', 'resolved', 'dismissed');

CREATE TABLE conflicts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id  UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    level       SMALLINT NOT NULL,          -- 1..4, per your four-level scheme
    kind        TEXT NOT NULL,              -- 'duplicate_brand', 'same_ingredient', ...
    description TEXT NOT NULL,              -- the human-readable message shown to the family
    item_a_id   UUID REFERENCES prescription_items(id) ON DELETE CASCADE,
    item_b_id   UUID REFERENCES prescription_items(id) ON DELETE CASCADE,
    status      conflict_status NOT NULL DEFAULT 'open',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES users(id)
);

CREATE INDEX idx_conflicts_patient ON conflicts(patient_id);

-- Deferred to later build steps (not needed yet):
--   brands / ingredients  -> Step 11 (brand-to-ingredient mapping, levels 2-3)