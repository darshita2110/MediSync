# MediSync delivery plan

Each stage ends with verification and its own Git commit. The user handles
commits manually. Publishing to a remote and deploying are separate actions.

| Stage | Deliverable | Status |
| --- | --- | --- |
| 1 | Backend reliability: API tests, role boundaries, patient isolation, validation, patient-local scheduling | Verified; staged for manual commit |
| 2 | Medicine lifecycle, caregiver revocation, automatic and complete Level 1 reconciliation | Verified; unstaged for a separate manual commit |
| 3 | Incremental migrations, CI, repeatable development and API documentation | Pending |
| 4 | Flutter app: authentication, patients, medicines, prescriptions, caregivers and dose timeline | Pending |
| 5 | Actionable notifications, background generation, escalation and family alerts | Pending |
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

Git signing is enabled. The agent's stalled signing attempt was cancelled at
the user's request; the user will make commits manually.

1. The index contains the verified stage 1 snapshot. Commit the currently staged
   files with: `fix: harden backend access and patient-local scheduling`.
2. After that commit, stage the remaining changes and new files (including the
   reconciliation service and tests). Commit with:
   `feat: add medicine lifecycle and automatic reconciliation`.

Next implementation stage: incremental migrations, CI, repeatable setup and
API documentation. Preserve the two checkpoints above before starting stage 3.
