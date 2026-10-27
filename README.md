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
  constraint prevents duplicate generation; an atomic conditional update
  prevents a confirmation from overwriting another caregiver's confirmation.
- **Audit log** — records who did what, since data is shared across people.

## Tech stack

- **Runtime:** Node.js + Express 5
- **Database:** PostgreSQL (via `pg`, raw parameterized SQL)
- **Auth:** bcrypt (password hashing) + jsonwebtoken (JWT)
- **Client:** Flutter Android/iOS/web app in `mobile` (see platform verification notes there)

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
  db/                   # versioned migration runner and legacy schema inspection
  app.js                # API setup + route mounting (importable by tests)
  index.js              # environment checks, listening and graceful shutdown
```

Every patient-scoped route runs two guards in sequence: `requireAuth`
(are you logged in?) then `requirePatientAccess` (may you touch *this*
patient?). Operations that must stay consistent — creating a patient with
its owner row, or a prescription with its medicines — run inside database
transactions.

## Data model

Sixteen application tables, plus a `schema_migrations` ledger:

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
| `dose_reminder_state` | durable reminder count and shared snooze             |
| `care_notifications` | per-user reminder and family-alert inbox             |
| `patient_worker_state` | daily reconciliation checkpoint                    |
| `reminder_worker_status` | background worker heartbeat                      |
| `push_devices` | authenticated Android installations and account bindings |
| `push_deliveries` | durable per-device delivery leases, retries and FCM acceptance |

## API overview

All `/api` routes except signup/login and health checks require an
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
- `DELETE /api/patients/:patientId/access/:accessId` — owner revokes a caregiver or pending invite

**Prescriptions**
- `POST /api/patients/:patientId/prescribers` — add a doctor
- `GET  /api/patients/:patientId/prescribers` — list doctors
- `POST /api/patients/:patientId/prescriptions` — add a visit + medicines
- `GET  /api/patients/:patientId/prescriptions` — list visits with medicines
- `GET  /api/patients/:patientId/items` — active medicines (reconciliation input)
- `PATCH /api/patients/:patientId/items/:itemId` — mark a medicine stopped/completed
- New prescription items can include `replaces_item_id` to replace an existing
  medicine immediately or from a future `start_date`.

**Conflicts**
- `POST  /api/patients/:patientId/conflicts/check` — run detection
- `GET   /api/patients/:patientId/conflicts` — list (`?status=open`)
- `PATCH /api/patients/:patientId/conflicts/:conflictId` — resolve/dismiss

**Schedules & doses**
- `POST  /api/patients/:patientId/items/:itemId/schedules` — add a dosing rule
- `GET   /api/patients/:patientId/schedules` — list active schedules
- `PATCH /api/patients/:patientId/schedules/:scheduleId` — deactivate a schedule
- `POST  /api/patients/:patientId/doses/generate` — generate upcoming doses
- `GET   /api/patients/:patientId/doses` — list doses (`?from=&to=`)
- `PATCH /api/patients/:patientId/doses/:doseId` — confirm taken/skipped
- `POST /api/patients/:patientId/doses/:doseId/snooze` — shared 10-minute snooze
- `GET /api/notifications` — caller's care inbox, with optional `before` cursor
- `PATCH /api/notifications/:notificationId/read` — mark an own alert read

## Getting started

### Prerequisites
- Node.js 22.14+ (Node 24 is used for local verification)
- PostgreSQL 16+ (PostgreSQL 18 is used for local verification)

### Setup

```bash
# 1. For a new installation, create an empty database.
#    Skip this if your medisync database already exists.
psql -U postgres -c "CREATE DATABASE medisync;"

# 2. Install the locked backend dependencies.
cd backend
npm ci

# 3. Create backend/.env from .env.example and configure it (see below).
#    Keep an existing .env; do not overwrite its credentials.

# 4. Inspect and apply versioned migrations; existing compatible data is retained.
npm run db:status
npm run db:migrate

# 5. Run
npm run dev
```

### Environment variables (`backend/.env`)

```
PORT=3000
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/medisync
JWT_SECRET=a-long-random-secret-string
DATABASE_SCHEMA=public
```

> If your password contains special characters (e.g. `#`), percent-encode
> them in the URL (`#` becomes `%23`).

Generate a unique secret locally with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
and save it as `JWT_SECRET`. Production requires at least 32 characters.
`.env` is ignored by Git; `.env.example` contains placeholders only.

The same `npm run db:migrate` command supports fresh and existing databases.
Applied files have checksums and are never reapplied. Failed upgrades roll back;
the runner never resets patient records. The former `database/schema.sql` is
retired. See [database/README.md](database/README.md) for migration rules and
[Docs/API.md](Docs/API.md) for request bodies, response envelopes and client flows.

## Project status

Stages 1-3 are committed: backend reliability, medicine lifecycle management,
caregiver revocation, reconciliation, migrations, integrity constraints and CI.
Stage 4 is committed and includes the Flutter core app and browser API integration.
Stage 5a adds the server reminder worker, shared snoozing, escalation and care
inbox. Stage 5b adds Android Firebase configuration, device enrollment, notification
review actions and durable delivery. Server OAuth authentication is verified; physical-phone
verification remains before stage 5 is complete; live/offline sync and deployment
are later stages.
See [Docs/REMINDERS.md](Docs/REMINDERS.md) to run the worker and prepare Firebase.
See [PROGRESS.md](PROGRESS.md) for verification and manual commit checkpoints.

### Run the Flutter client

With the backend running on port 3000, open another terminal:

```powershell
cd mobile
flutter pub get --enforce-lockfile
flutter run -d chrome --web-port=5173 --dart-define=API_BASE_URL=http://localhost:3000
```

See [mobile/README.md](mobile/README.md) for Android, iOS, secure sessions,
connection configuration, tests and platform limitations. Browser sessions end
when the page is refreshed. The app uses the real API; it contains no demo mode.

### Permissions

| Role | Access |
| --- | --- |
| `owner` | Full patient access, medicine management, invitations, dose confirmation |
| `family_admin` | Medical records, medicine management and dose confirmation |
| `helper` | Today's schedules and doses, and confirmation of today's doses |
| `viewer` | Read-only medical records, schedules, doses and caregiver list |

Invitations grant no patient access until the invited user accepts them.
Only the owner can invite or revoke caregivers. The owner cannot be removed.

### Medicine changes and reconciliation

- A prescription and all its medicines, replacements and detected conflicts save
  in one transaction. An invalid replacement rolls the whole batch back.
- `PATCH .../items/:itemId` accepts `status: "stopped"` or `"completed"`.
  Schedules are deactivated and future unconfirmed forecasts are removed;
  confirmed doses and historical records are preserved.
- A replacement item includes `replaces_item_id`. An immediate replacement
  stops the previous item. A future replacement bounds its previous course and
  schedules to the day before the new course starts, without stopping it early.
- New prescriptions and lifecycle changes run reconciliation automatically.
  Explicit checks remain available. The separate reminder worker also checks
  each patient's records once per patient-local date.
- Level 1 flags every duplicate-name pair, different recorded instructions and
  active courses past their recorded end date. Findings include doctor/date
  context and ask the user to check with the prescriber.
- When both ingredient names have already been recorded, a match across brands
  is labelled Level 2. Automatic brand mapping remains planned; unknown medicines
  are never guessed.
- Repeated and concurrent checks do not duplicate findings. Dismissals are kept;
  open findings are resolved when the underlying recorded conflict disappears.
  `?status=all` returns the conflict history.
- Overlapping active schedules for the same medicine and time are rejected.
  Deactivate a schedule before replacing its dosing rule.

### Scheduling semantics

- Schedule times and medicine date windows use the patient's IANA timezone.
- `days_ahead: 0` generates today's doses only; the default is 7 (today plus
  the next seven days), with a maximum of 30.
- Generation respects both medicine and schedule dates, active status and
  weekday filters. Repeating a generation request creates no duplicates.
- `GET .../doses?from=YYYY-MM-DD&to=YYYY-MM-DD` includes the entire `to` date
  in the patient's timezone. Both dates must be valid calendar dates.
- Helpers always receive today's timeline, even if they request another range.
- An atomic conditional update protects dose confirmation; the unique constraint
  protects dose generation. A later confirmation returns `409` with the saved
  confirmation rather than overwriting it.

### Tests

From `backend`:

```bash
npm run check
npm test
npm run test:integration
```

Unit tests run without PostgreSQL. Integration tests use `TEST_DATABASE_URL` if
provided; otherwise they use a local `DATABASE_URL` from `backend/.env`.
Remote databases require an explicit `TEST_DATABASE_URL`.

Integration tests create a random `medisync_test_*` schema, verify the active
schema before applying migrations and fixtures, and remove it on completion.
They never reset the existing `public` schema. The database user needs permission
to create schemas. Test credentials are synthetic and are removed with the schema.

GitHub Actions runs the backend checks on pushes and pull requests with Node
22/24 and PostgreSQL 16/18. It installs the lockfile using `npm ci`, runs syntax,
unit and integration checks, and verifies repeat application of the migration CLI.
The workflow's PostgreSQL credentials are synthetic and only used by its
disposable service. Hosted CI results are available after the commit is pushed.

## License

ISC
