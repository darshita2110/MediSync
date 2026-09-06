# MediSync

A medication-reconciliation and coordination backend for patients who see
multiple doctors and are cared for by multiple family members.

## The problem

An elderly patient often sees several specialists who don't talk to each
other. One prescribes a medicine; months later another prescribes the same
drug under a different brand name. Nobody notices, and the patient ends up
double-dosing. At the same time, several family members share caregiving —
and a dose can be given twice because two of them each thought the other
had missed it.

MediSync is the shared source of truth that prevents both failures. It
tracks **which doctor prescribed what**, flags **duplicate or overlapping
medicines**, and coordinates the family around a single **dose timeline**
that can't be double-confirmed.

## Core features

- **Authentication** — email/password signup and login with hashed
  passwords (bcrypt) and JWT-based sessions.
- **Patients vs. users** — a *patient* (whose medicines are tracked) is
  distinct from a *user* (a person with a login). One patient, many
  caregivers.
- **Multi-caregiver access** — invite family or helpers by email at four
  role levels (`owner`, `family_admin`, `helper`, `viewer`), with an
  invite → accept handshake so nobody is added without consent.
- **Prescriptions** — record doctors, visits, and the medicines on each
  visit, with dose, frequency, and start/end dates.
- **Conflict detection (Level 1)** — compares a patient's currently-active
  medicines and flags duplicates prescribed across different doctors.
- **Schedules & doses** — turn a rule ("once daily at 8am") into concrete
  dose events on a timeline that caregivers mark taken/skipped. A unique
  constraint prevents both duplicate dose generation and double
  confirmation.
- **Audit log** — records who did what, since data is shared across people.

## Tech stack

- **Runtime:** Node.js + Express 5
- **Database:** PostgreSQL (via `pg`, raw parameterized SQL)
- **Auth:** bcrypt (password hashing) + jsonwebtoken (JWT)
- **Planned client:** Flutter mobile app

## Architecture

The backend follows a layered structure:

```
src/
  config/db.js          # single shared PostgreSQL connection pool
  middleware/
    auth.middleware.js       # verifies JWT, attaches req.user
    access.middleware.js     # verifies caller has access to :patientId
  controllers/          # request logic, one file per feature
  routes/               # URL -> controller mapping, one file per feature
  utils/audit.js        # audit-log helper
  index.js              # app setup + route mounting
```

Every patient-scoped route runs two guards in sequence: `requireAuth`
(are you logged in?) then `requirePatientAccess` (may you touch *this*
patient?). Operations that must stay consistent — creating a patient with
its owner row, or a prescription with its medicines — run inside database
transactions.

## Data model

Ten tables:

| Table                | Purpose                                             |
|----------------------|-----------------------------------------------------|
| `users`              | login accounts                                      |
| `patients`           | the people whose medicines are tracked              |
| `patient_access`     | which user can see which patient, at what role      |
| `audit_log`          | record of actions taken                             |
| `prescribers`        | doctors                                             |
| `prescriptions`      | a visit (doctor + date)                             |
| `prescription_items` | one medicine on a visit (dose, dates, replaces)     |
| `schedules`          | repeating dosing rule for a medicine                |
| `dose_events`        | individual generated doses, confirmed by caregivers |
| `conflicts`          | detected reconciliation problems                    |

## API overview

All `/api` routes except signup/login require an
`Authorization: Bearer <token>` header. Patient-scoped routes also require
the caller to have accepted access to that patient.

**Auth**
- `POST /api/auth/signup` — create account, returns user + token
- `POST /api/auth/login` — returns user + token

**Patients & access**
- `POST /api/patients` — create a patient (caller becomes owner)
- `GET  /api/patients` — list patients the caller can access
- `POST /api/patients/:patientId/invites` — invite a user by email + role
- `GET  /api/invites` — invites awaiting the caller
- `POST /api/invites/:accessId/accept` — accept an invite
- `GET  /api/patients/:patientId/access` — list a patient's caregivers

**Prescriptions**
- `POST /api/patients/:patientId/prescribers` — add a doctor
- `GET  /api/patients/:patientId/prescribers` — list doctors
- `POST /api/patients/:patientId/prescriptions` — add a visit + medicines
- `GET  /api/patients/:patientId/prescriptions` — list visits with medicines
- `GET  /api/patients/:patientId/items` — active medicines (reconciliation input)

**Conflicts**
- `POST  /api/patients/:patientId/conflicts/check` — run detection
- `GET   /api/patients/:patientId/conflicts` — list (`?status=open`)
- `PATCH /api/patients/:patientId/conflicts/:conflictId` — resolve/dismiss

**Schedules & doses**
- `POST  /api/patients/:patientId/items/:itemId/schedules` — add a dosing rule
- `GET   /api/patients/:patientId/schedules` — list active schedules
- `POST  /api/patients/:patientId/doses/generate` — generate upcoming doses
- `GET   /api/patients/:patientId/doses` — list doses (`?from=&to=`)
- `PATCH /api/patients/:patientId/doses/:doseId` — confirm taken/skipped

## Getting started

### Prerequisites
- Node.js 18+
- PostgreSQL 13+

### Setup

```bash
# 1. Create the database
psql -U postgres -c "CREATE DATABASE medisync;"

# 2. Apply the schema
psql -U postgres -d medisync -f database/schema.sql

# 3. Install backend dependencies
cd backend
npm install

# 4. Configure environment
#    Create backend/.env based on .env.example (see below)

# 5. Run
npm run dev
```

### Environment variables (`backend/.env`)

```
PORT=3000
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/medisync
JWT_SECRET=a-long-random-secret-string
```

> If your password contains special characters (e.g. `#`), percent-encode
> them in the URL (`#` becomes `%23`).

## Project status

Backend core complete: auth, patients, multi-caregiver access, prescriptions,
Level 1 conflict detection, and schedules/doses.

Planned next: Flutter client; automated dose generation (node-cron);
missed-dose escalation and family alerts; real-time sync (WebSockets);
higher conflict levels (brand → ingredient mapping); deployment.

## License

ISC
