/**
 * Pure decision logic for the migration runner.
 *
 * Imports NOTHING from `pg`, `fs`, or `../config/env` — only `node:crypto`.
 * The I/O shell (`migrate.ts`) reads files, talks to Postgres, and calls into
 * this module for every branch decision, mirroring the mobile side's
 * pure-reducer pattern (`adaptiveCapture.ts` / `captureCoordinator.ts`).
 */
import { createHash } from 'node:crypto';

/**
 * Arbitrary fixed key that serialises concurrent `db:migrate` runs via
 * `pg_try_advisory_lock`. The value carries no meaning beyond being stable
 * across runs; it just needs to be one number nothing else in the codebase
 * locks on. Always cast to `::bigint` in SQL — an untyped bound parameter
 * picks the wrong `pg_try_advisory_lock` overload.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 729548001;

export type StartupMode = 'fresh' | 'baseline' | 'normal' | 'ambiguous';

/**
 * Landmark schema probes. `users` = migration 000, `quizQuestions` = 011,
 * `customMissions` = 012, `childrenInterests` = 014. Together they say "this DB
 * has been carried to the current head", the only safe condition for a blind
 * full stamp (`baseline`).
 */
export interface SchemaProbe {
  users: boolean;
  quizQuestions: boolean;
  customMissions: boolean;
  childrenInterests: boolean;
}

export interface AppliedMigration {
  filename: string;
  checksum: string;
}

export interface DriftedMigration {
  filename: string;
  recorded: string;
  actual: string;
}

export interface MigrationPlan {
  /** Files with no ledger row, in the input (sorted) order. */
  pending: string[];
  /** Files whose ledger checksum ≠ current checksum. */
  drifted: DriftedMigration[];
  /** Ledger rows with no corresponding file on disk. */
  orphaned: string[];
}

export interface BaselineSplit {
  /** Files ≤ target — stamped as applied without executing. */
  stamp: string[];
  /** Files > target — run normally. */
  run: string[];
}

/**
 * Canonicalise a migration file's text before hashing.
 *
 * Handles ONLY the things that legitimately differ between a CRLF and an LF
 * checkout of the *same* file (this repo is `core.autocrlf=true` with no
 * `.gitattributes`):
 *   - a leading UTF-8 BOM
 *   - `\r\n` and lone `\r` line endings
 *   - trailing whitespace at end of file
 *
 * Deliberately does NOT per-line trim, collapse internal whitespace, strip
 * comments, or change case — a real one-character content edit must still
 * change the checksum.
 */
export function normalizeSql(raw: string): string {
  let s = raw;
  if (s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1);
  }
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(/\s+$/, '');
  return s;
}

/** `sha256` hex of `normalizeSql(raw)`. */
export function checksumSql(raw: string): string {
  return createHash('sha256').update(normalizeSql(raw), 'utf8').digest('hex');
}

/**
 * Split the sorted file list against the ledger.
 *
 * `files` is already `.sort()`ed. `pending` preserves that order.
 * `drifted` and `orphaned` never overlap `pending`.
 */
export function planMigrations(
  files: string[],
  applied: AppliedMigration[],
  checksumOf: (filename: string) => string,
): MigrationPlan {
  const recordedByName = new Map(applied.map((a) => [a.filename, a.checksum]));
  const fileSet = new Set(files);

  const pending: string[] = [];
  const drifted: DriftedMigration[] = [];

  for (const filename of files) {
    const recorded = recordedByName.get(filename);
    if (recorded === undefined) {
      pending.push(filename);
      continue;
    }
    const actual = checksumOf(filename);
    if (actual !== recorded) {
      drifted.push({ filename, recorded, actual });
    }
  }

  const orphaned = applied
    .map((a) => a.filename)
    .filter((filename) => !fileSet.has(filename))
    .sort();

  return { pending, drifted, orphaned };
}

/**
 * Pick the startup mode from the ledger row count and the landmark probe.
 * See ALL_IS_FIXED #3 §4.2. `MIGRATE_BASELINE_UPTO`, when set, overrides this
 * entirely in the shell — it is the escape hatch for the `ambiguous` case.
 */
export function decideStartupMode(
  ledgerCount: number,
  probe: SchemaProbe,
): StartupMode {
  if (ledgerCount > 0) {
    return 'normal';
  }
  if (!probe.users) {
    return 'fresh';
  }
  if (probe.quizQuestions && probe.customMissions && probe.childrenInterests) {
    return 'baseline';
  }
  return 'ambiguous';
}

/**
 * For `MIGRATE_BASELINE_UPTO=<file>`: everything up to and including `target`
 * is stamped as applied, everything after it is run. `files` must be sorted.
 * An unknown `target` throws — a typo must not silently stamp the whole set.
 */
export function resolveBaselineUpTo(files: string[], target: string): BaselineSplit {
  const idx = files.indexOf(target);
  if (idx === -1) {
    throw new Error(
      `MIGRATE_BASELINE_UPTO="${target}" matches no migration file. ` +
        `Expected a bare basename, one of: ${files.join(', ')}`,
    );
  }
  return {
    stamp: files.slice(0, idx + 1),
    run: files.slice(idx + 1),
  };
}
