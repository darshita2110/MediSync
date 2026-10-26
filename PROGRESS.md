# MediSync delivery plan

Each stage ends with verification and its own Git commit. The user handles
commits manually. Publishing to a remote and deploying are separate actions.

| Stage | Deliverable | Status |
| --- | --- | --- |
| 1 | Backend reliability: API tests, role boundaries, patient isolation, validation, patient-local scheduling | Committed in 37e9e4b |
| 2 | Medicine lifecycle, caregiver revocation, automatic and complete Level 1 reconciliation | Committed in 37e9e4b |
| 3 | Incremental migrations, CI, repeatable development and API documentation | Committed in 948c29b |
| 4 | Flutter app: authentication, patients, medicines, prescriptions, caregivers and dose timeline | Committed in 1cd95c4 |
| 5 | Actionable notifications, background generation, escalation and family alerts | Stage 5a worker/inbox implemented; Firebase push setup pending |
| 6 | Live updates and persistent offline dose queue with first-confirmation-wins handling | Pending |
| 7 | Curated medicine mapping with explicit uncertainty and higher conflict levels | Pending |
| 8 | Deployment, release builds and end-to-end device verification | Pending |

The first demonstrable app ends at stage 5. Features after that remain part of
the end-to-end delivery plan. External credentials and physical-device checks
will be recorded explicitly; implementation alone does not prove push delivery.

## Verification policy

- Exercise API behavior against an isolated PostgreSQL test schema.
- Never reset the existing development database to run tests.
- Test access boundaries, concurrent confirmations, dates and timezones.
- Run appropriate Flutter checks when the client exists.
- Update this file with actual results before committing each stage.

## Stage 1 verification - 2026-10-25

- 7 unit tests passed for dates, times, identifiers, email, passwords and limits.
- 17 PostgreSQL-backed API tests passed in an isolated schema, including role
  boundaries, invite consent, cross-patient doctor rejection, calendar windows,
  daylight-saving changes, repeat generation and concurrent dose confirmation.
- JavaScript syntax checks and `git diff --check` passed.
- Existing development data was preserved. No new runtime dependencies added.

## Stage 2 verification - 2026-10-25

- 11 unit tests and 29 isolated PostgreSQL API tests passed.
- Checked immediate and future replacements, rollback of failed replacement
  batches, preservation of dose history, schedule overlap prevention, caregiver
  revocation, automatic reconciliation and concurrent repeat checks.
- No schema reset, new runtime dependency, or change to existing patient data.

## Manual commit checkpoints

Git signing is enabled. The user handles commits manually.
Stages 1 and 2 were committed together in `37e9e4b` and the working tree was
clean when stage 3 began. The previous staging instructions are superseded.

Stage 3 was committed as `948c29b` during stage 4 development.
Stage 4 was committed as `1cd95c4`.
Stage 5a suggested commit message: `feat: add durable reminders and care alert inbox`.
Next checkpoint: Firebase setup, device enrollment, push delivery and notification actions.

## Stage 3 verification - 2026-10-25

- `npm run check`, `npm test` and `npm run test:integration` passed:
  32 JavaScript files checked, 13 unit tests and 42 integration tests passed.
- Fresh migration setup, repeated application, exact preservation of legacy rows,
  concurrent migration runners, checksum drift, failed-upgrade rollback,
  cross-patient database constraints and existing deletion behavior were checked.
- Applied the migrations to the local PostgreSQL 18.6 database: migration 001
  adopted the existing schema and migration 002 added integrity checks/indexes.
  Record counts and content hashes in all ten application tables were identical
  before and after. Repeated migration application was a no-op.
- Migration status/CLI verified. The retired `database/schema.sql` no longer
  drops tables. No runtime dependencies were added.
- CI workflow prepared for Node 22/24 and PostgreSQL 16/18. Hosted CI has not
  run during this stage; its result is available after a commit is pushed.
- Setup and API contract documented in `README.md`, `database/README.md` and
  `Docs/API.md`.

## Stage 4 verification - 2026-10-25

- Added the Flutter Android/iOS/web client, API adapter, mobile secure-session
  storage, browser memory sessions and role-specific care screens.
- Implemented patients, dose timelines and confirmations, doctors/visits,
  multi-medicine prescriptions, schedules, medicine lifecycle/replacements,
  conflict review/history and caregiver invitations/consent/revocation.
- Flutter analysis is clean and all 19 tests passed (11 API/session/model tests
  and 8 widget workflows). Checked narrow layouts at enlarged text size,
  expired-session route removal, preservation of a winning confirmation, and
  partial prescription/schedule saves.
- Backend checks passed: 35 JavaScript files checked, 15 unit tests and 45
  PostgreSQL integration tests. Added exact-origin browser CORS, calendar DATE
  serialization, dose eligibility and readable review labels.
- Real Dart HTTP client smoke test passed against the Node/PostgreSQL API in an
  isolated schema, including invitations, consent and duplicate confirmation.
- Browser QA passed on desktop and at a 390-pixel phone width: sign-in,
  patient navigation, timeline, review, people, visits and prescription entry.
  Screenshots were visually inspected; no browser JavaScript errors occurred.
- Flutter web profile build and Android debug APK build passed. APK:
  `mobile/build/app/outputs/flutter-apk/app-debug.apk` (ignored by Git).
- iOS was scaffolded but not built on Windows. No physical Android device was
  connected; native secure-store/device behavior remains a release-stage check.
- Temporary QA API/schema and web preview were stopped after verification.
  Existing development patient data was not used for QA or changed.
- Flutter CI added for formatting, analysis, tests, actual client/API smoke
  verification and Android/web compilation. Hosted CI has not run in this stage.

Stage 4 is committed. Its core app is extended by the stage 5a work below.


## Stage 5a verification - 2026-10-26

- Implemented a separate server worker for automatic patient-local dose
  generation, daily reconciliation, up to three reminders, shared 10-minute
  snoozing, +45-minute missed state and family-only escalation.
- Database decisions, reminder counters and inbox records are durable and
  transactional. Parallel workers, restarts, delayed ticks, old backlog,
  confirmation races, late confirmation, membership/role boundaries, revoked
  access, re-invitation history and inbox pagination/read state are covered.
- Backend checks passed: 40 JavaScript files checked, 17 unit tests and 53
  isolated PostgreSQL integration tests (70 tests total).
- Flutter analysis is clean and all 22 API/session/widget tests passed. Added
  the care inbox, worker-delay status, shared snooze and late-confirmation
  controls, including narrow screens with enlarged text.
- The actual Dart HTTP client passed against the isolated API/PostgreSQL worker:
  generation, reminder decoding, heartbeat, read state, helper snoozing,
  family-only escalation and late confirmation reflected in historical alerts.
- Migration 003 applied to the local development database. Content hashes and
  counts in all ten original tables were unchanged; repeat application was a
  no-op. The worker was exercised only in isolated test/QA schemas.
- Web profile and Android debug APK builds passed. Visual browser QA passed at
  desktop and 390-pixel phone width, with actual Snooze and Mark read requests
  and no JavaScript errors. Screenshots were inspected.
- The temporary client API/test schema and web preview were stopped after QA.
  No production push was sent. Physical Android/iOS verification remains pending.
- No runtime dependencies were added. The `.env`, temporary QA files, SDK/build
  outputs and server credential directory remain ignored.
- Startup instructions, API contract, timing/outage semantics and Firebase
  preparation are in `Docs/REMINDERS.md`. Run both API and worker for reminders.

Stage 5 remains open: the user confirmed Firebase setup is still needed.
Phone push, lock-screen actions, durable device delivery/retries and real-device
foreground/background checks are the next checkpoint. Stage 6 live/offline sync,
stage 7 medicine mapping and stage 8 deployment/release also remain pending.
