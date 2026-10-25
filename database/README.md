# Database migrations

Run these commands from `backend`, after installing dependencies and configuring
`backend/.env`:

```bash
npm run db:status
npm run db:migrate
```

The target is `DATABASE_URL` and `DATABASE_SCHEMA` (default `public`). Migration
commands load `.env` relative to the backend directory. `db:status` is read-only.
The user must own the target schema/tables and be allowed to create tables and
indexes. The API and migration commands must use the same schema.

## Fresh and existing databases

For a fresh database, the runner applies `001_initial.sql`, then the remaining
migrations in order. It creates a `schema_migrations` ledger alongside the ten
application tables.

For the existing pre-migration MediSync database, it first compares columns,
types, defaults, nullability, primary/unique/foreign/check constraints, and enum
labels with `baseline.json`. A matching schema is adopted as migration 001;
none of its tables or rows are recreated. Migration 002 adds integrity checks,
cross-patient foreign keys, and indexes without rewriting application records.
Non-constraint index names are not part of baseline recognition.

If the schema is partial or differs from the baseline, the runner stops.
If existing rows violate a new constraint, the upgrade fails and rolls back.
Resolve the specific inconsistency deliberately and rerun; the runner does not
delete, normalize, or silently repair existing records. Never bypass checks by
manually inserting ledger entries.

`schema.sql` is retired and intentionally executes no SQL. The old version
dropped every table; it must not be used to upgrade a populated database.

## Adding a migration

1. Add the next sequential file: `003_description.sql`, `004_description.sql`, etc.
2. Keep applied files immutable. SHA-256 checksums reject edited or unknown
   history. Line endings are normalized so Windows and Linux agree.
3. Put only the forward change in the new file. Do not include `BEGIN`, `COMMIT`,
   or operations such as `CREATE INDEX CONCURRENTLY` that cannot run inside the
   runner's transaction. Do not edit `baseline.json` for later migrations.
4. Extend migration/API tests and run all checks before committing.

An advisory lock serializes runners per database/schema. All pending migrations
and ledger changes run in one transaction. Failures roll back the entire pending
batch. Table-lock acquisition is limited to five seconds and statements to
30 seconds, so a busy database fails rather than waiting indefinitely.

There is no automatic destructive rollback command. To change an applied
migration, write another forward migration. Back up a populated database before
a release and test the migration against a separate restored copy.

## Verification

```bash
npm run check
npm test
npm run test:integration
```

Integration tests use a random `medisync_test_*` schema for each scenario and
remove it afterwards. They verify fresh setup, preservation of existing rows,
checksum validation, concurrent runners, failed-upgrade rollback, and database
constraints even when requests bypass the API.

The GitHub Actions workflow additionally exercises Node 22/24 and PostgreSQL
16/18 with a dedicated disposable PostgreSQL service.
