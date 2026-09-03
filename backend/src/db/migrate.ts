import fs from 'fs';
import path from 'path';
import type { PoolClient } from 'pg';
import { pool } from './pool';
import { logger } from '../utils/logger';
import {
  MIGRATION_ADVISORY_LOCK_KEY,
  checksumSql,
  decideStartupMode,
  planMigrations,
  resolveBaselineUpTo,
  type SchemaProbe,
} from './migrationPlan';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function readMigrationFilenames(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function readSql(filename: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
}

async function probeSchema(client: PoolClient): Promise<SchemaProbe> {
  const { rows } = await client.query<{
    users: boolean;
    quiz_questions: boolean;
    custom_missions: boolean;
    children_interests: boolean;
  }>(
    `SELECT to_regclass('public.users')           IS NOT NULL AS users,
            to_regclass('public.quiz_questions')  IS NOT NULL AS quiz_questions,
            to_regclass('public.custom_missions') IS NOT NULL AS custom_missions,
            EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'children'
                AND column_name = 'interests'
            ) AS children_interests`,
  );
  const r = rows[0];
  return {
    users: r.users === true,
    quizQuestions: r.quiz_questions === true,
    customMissions: r.custom_missions === true,
    childrenInterests: r.children_interests === true,
  };
}

/** Insert ledger rows for files we are NOT executing (baseline / MIGRATE_BASELINE_UPTO). */
async function stampAsApplied(
  client: PoolClient,
  filenames: string[],
  checksumOf: (f: string) => string,
): Promise<void> {
  await client.query('BEGIN');
  try {
    for (const filename of filenames) {
      await client.query(
        `INSERT INTO schema_migrations (filename, checksum, duration_ms)
         VALUES ($1, $2, 0)
         ON CONFLICT (filename) DO NOTHING`,
        [filename, checksumOf(filename)],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

class MigrationFailed extends Error {
  constructor(public readonly filename: string) {
    super(`Migration failed: ${filename}`);
    this.name = 'MigrationFailed';
  }
}

/** Run each pending file + its ledger insert in one transaction, in order. */
async function applyPending(
  client: PoolClient,
  pending: string[],
  checksumOf: (f: string) => string,
): Promise<number> {
  let applied = 0;
  for (const filename of pending) {
    const sql = readSql(filename);
    const startedAt = Date.now();
    await client.query('BEGIN');
    try {
      // B3: pass the file body as a BARE string. node-pg only allows a
      // multi-statement query on the simple protocol, which it uses iff there
      // is no values array. `{ text, values: [] }` would switch to the extended
      // protocol and fail on the 2nd statement of every migration file.
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (filename, checksum, duration_ms)
         VALUES ($1, $2, $3)`,
        [filename, checksumOf(filename), Date.now() - startedAt],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Migration failed — rolled back, no ledger row written', {
        file: filename,
        err: err instanceof Error ? err.message : String(err),
      });
      throw new MigrationFailed(filename);
    }
    logger.info(`Applied migration: ${filename}`, { durationMs: Date.now() - startedAt });
    applied += 1;
  }
  return applied;
}

function missingLandmarks(probe: SchemaProbe): string[] {
  const missing: string[] = [];
  if (!probe.quizQuestions) missing.push('quiz_questions');
  if (!probe.customMissions) missing.push('custom_missions');
  if (!probe.childrenInterests) missing.push('children.interests');
  return missing;
}

/** Human-facing block — printed raw (not JSON) so a tired operator can act on it. */
function printAmbiguousMessage(probe: SchemaProbe): void {
  const missing = missingLandmarks(probe).join(', ');
  console.error(
    [
      'Refusing to migrate: this database has schema but no migration ledger, and it is',
      `not at the current head (missing: ${missing}).`,
      '',
      'Running the remaining migrations blindly could fail partway. Choose one:',
      '',
      '  * If you know which migration was last applied:',
      '      MIGRATE_BASELINE_UPTO=012_custom_missions.sql npm run db:migrate',
      '    -> stamps everything up to and including that file as applied, then runs the rest.',
      '',
      '  * If this database holds nothing you need:',
      '      docker compose down -v && docker compose up -d && npm run db:migrate',
      '',
      'No changes were made.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const files = readMigrationFilenames();

  const checksumCache = new Map<string, string>();
  const checksumOf = (filename: string): string => {
    let c = checksumCache.get(filename);
    if (c === undefined) {
      c = checksumSql(readSql(filename));
      checksumCache.set(filename, c);
    }
    return c;
  };

  const client = await pool.connect();
  let lockAcquired = false;
  try {
    const lockRes = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [MIGRATION_ADVISORY_LOCK_KEY],
    );
    lockAcquired = lockRes.rows[0]?.locked === true;
    if (!lockAcquired) {
      logger.error('Another migration run holds the advisory lock — aborting', {
        lockKey: MIGRATION_ADVISORY_LOCK_KEY,
      });
      process.exitCode = 1;
      return;
    }

    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename    TEXT PRIMARY KEY,
         checksum    CHAR(64) NOT NULL,
         applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         duration_ms INTEGER NOT NULL DEFAULT 0
       )`,
    );

    const ledger = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const appliedRows = ledger.rows;
    const probe = await probeSchema(client);
    const plan = planMigrations(files, appliedRows, checksumOf);

    // A previously-applied file was edited — refuse for every path that could
    // then execute something. (drifted is always empty when the ledger is
    // empty, so fresh / baseline are unaffected.)
    if (plan.drifted.length > 0) {
      for (const d of plan.drifted) {
        logger.error('Migration file changed after it was applied', {
          file: d.filename,
          recordedChecksum: d.recorded,
          currentChecksum: d.actual,
        });
      }
      logger.error(
        'A previously-applied migration was edited. Migrations are append-only: add a ' +
          'new numbered file, never edit an applied one. Revert the file(s) above. No changes were made.',
      );
      process.exitCode = 1;
      return;
    }

    // B1: read MIGRATE_BASELINE_UPTO here, BEFORE the mode branch. When set it
    // overrides decideStartupMode entirely — it is the escape hatch the §4.5
    // `ambiguous` message points operators at, and step 7 below would have
    // already exited before it could ever take effect.
    const baselineUpTo = process.env.MIGRATE_BASELINE_UPTO?.trim();

    let mode: string;
    let pending: string[];

    if (baselineUpTo) {
      const { stamp, run } = resolveBaselineUpTo(files, baselineUpTo); // unknown target throws
      await stampAsApplied(client, stamp, checksumOf);
      const appliedNames = new Set(appliedRows.map((r) => r.filename));
      pending = run.filter((f) => !appliedNames.has(f));
      mode = `baseline-upto:${baselineUpTo}`;
      logger.warn('MIGRATE_BASELINE_UPTO override — stamped files as applied without executing them', {
        upTo: baselineUpTo,
        stamped: stamp.length,
        willRun: pending.length,
      });
    } else {
      const decided = decideStartupMode(appliedRows.length, probe);
      mode = decided;

      if (decided === 'ambiguous') {
        printAmbiguousMessage(probe);
        process.exitCode = 1;
        return;
      }

      if (decided === 'baseline') {
        await stampAsApplied(client, files, checksumOf);
        logger.warn(
          'baseline mode — pre-ledger database is already at the current head; ' +
            'stamped all migrations as applied and executed none',
          { stamped: files.length },
        );
        logger.info(
          `Migrations complete — mode=baseline applied=0 alreadyApplied=${files.length}`,
        );
        return;
      }

      // 'fresh' | 'normal'
      pending = plan.pending;
    }

    if (plan.orphaned.length > 0) {
      logger.warn('Ledger rows with no migration file on disk (ignored, not an error)', {
        orphaned: plan.orphaned,
      });
    }

    const appliedCount = await applyPending(client, pending, checksumOf);
    if (appliedCount === 0 && mode === 'normal') {
      logger.info(`Database already up to date (${files.length} migrations).`);
    } else {
      logger.info(
        `Migrations complete — mode=${mode} applied=${appliedCount} alreadyApplied=${
          files.length - appliedCount
        }`,
      );
    }
  } catch (err) {
    if (err instanceof MigrationFailed) {
      logger.error('Migration run aborted', { failedAt: err.filename });
    } else {
      logger.error('Migration run failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    process.exitCode = 1;
  } finally {
    // C1: never process.exit() from inside try — it skips this block and can
    // truncate stdout on Windows. Unlock -> release -> end, then let the
    // process end on its own with whatever process.exitCode was set.
    try {
      if (lockAcquired) {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
      }
    } catch (err) {
      logger.warn('Failed to release advisory lock (session end will clear it)', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    client.release();
    await pool.end();
  }
}

main().catch(async (err) => {
  // Reached only if something throws before the try (e.g. pool.connect() fails).
  logger.error('Migration runner could not start', {
    err: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
  try {
    await pool.end();
  } catch {
    /* nothing left to do */
  }
});
