# Database setup (local dev)

## Option A — Docker (recommended, matches `.env` defaults)

Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```powershell
cd backend
npm run db:setup
npm run dev
```

This starts PostgreSQL with `postgres` / `postgres` on port `5432` and runs migrations.

## Option B — Existing PostgreSQL install

Edit `backend/.env` and set your real credentials:

```env
DATABASE_URL=postgresql://YOUR_USER:YOUR_PASSWORD@localhost:5432/pfe_parental_control
```

Create the database:

```sql
CREATE DATABASE pfe_parental_control;
```

Run migrations:

```powershell
npm run db:migrate
npm run dev
```

## If port 5432 is already in use (your case)

You have **PostgreSQL 18** running locally (`postgresql-x64-18`). Docker cannot bind to port 5432 until you stop that service.

**Fix:** set the password you chose when installing PostgreSQL 18 in `.env`:

```env
DATABASE_URL=postgresql://postgres:YOUR_REAL_PASSWORD@localhost:5432/pfe_parental_control
```

Create the database in **pgAdmin** or **psql**:

```sql
CREATE DATABASE pfe_parental_control;
```

Then:

```powershell
npm run db:migrate
npm run dev
```

### Forgot the postgres password?

Reset it in psql (run as admin) or via pgAdmin → Login/Group Roles → postgres → Definition.

### Prefer Docker instead?

1. Stop Windows service: `Stop-Service postgresql-x64-18` (or Services app)
2. Start **Docker Desktop**
3. `npm run db:setup`

## Migrations & the `schema_migrations` ledger

`npm run db:migrate` (`tsx src/db/migrate.ts`) tracks applied files in a
`schema_migrations` table the runner creates itself. Consequences:

- **Re-running is a safe no-op.** `docker compose down -v` is **not** a recovery
  path any more — use it only to deliberately throw a database away.
- Each file runs in **its own transaction** together with its ledger insert. A
  failing migration rolls back completely: no ledger row, no partial schema.
- Editing an **already-applied** file is detected by SHA-256 checksum and the run
  **aborts** (exit 1). Migrations are append-only.
- **First run against a pre-ledger database** (schema already present, no
  `schema_migrations`): the runner probes landmark objects (`users`,
  `quiz_questions`, `custom_missions`, `children.interests`). All present → it
  stamps every file as applied and executes nothing (`baseline` mode). Any
  missing → it refuses and prints an actionable message; resume with
  `MIGRATE_BASELINE_UPTO=<basename> npm run db:migrate`, which stamps everything
  up to and including that file and runs the rest. `MIGRATE_BASELINE_UPTO` is a
  one-off operator tool read straight from the environment — it is **not** in
  `src/config/env.ts`.
- `baseline` mode **trusts the four probes**; it does not diff the live schema
  against the files. A database hand-patched off-script will be recorded as
  at-head.
- The runner only works via `tsx` — `tsc` (`npm run build`) does not copy `.sql`
  files into `dist/`, so `node dist/db/migrate.js` would find no migrations.

### Writing a new migration

1. Next number, **zero-padded to 3 digits** (`016_*.sql`, `017_*.sql`, …). The
   numbering has a gap at `004`; that is fine. An unpadded prefix (`9_foo.sql`)
   would sort wrongly — always pad.
2. **Never edit a file once it has been applied anywhere.** Add a follow-up
   migration instead; the checksum guard will otherwise abort every run.
3. Each file executes inside a transaction, so statements that cannot run in one
   (`CREATE INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE`, `VACUUM`) are not
   supported in a migration.
