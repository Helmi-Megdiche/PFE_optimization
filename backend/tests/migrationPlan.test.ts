import {
  normalizeSql,
  checksumSql,
  planMigrations,
  decideStartupMode,
  resolveBaselineUpTo,
  type AppliedMigration,
  type SchemaProbe,
} from '../src/db/migrationPlan';

/** The real file set (15 files, no `004`). Sorted, as the runner sorts it. */
const FILES = [
  '000_init.sql',
  '001_screen_events.sql',
  '002_dev_seed.sql',
  '003_usage_sessions.sql',
  '005_add_tflite_risk.sql',
  '006_add_app_label.sql',
  '007_missions_gamification.sql',
  '008_add_smart_badges.sql',
  '009_add_screen_events_child_created_idx.sql',
  '010_parent_approval_escape.sql',
  '011_quiz_questions.sql',
  '012_custom_missions.sql',
  '013_quiz_media_violence.sql',
  '014_child_interests.sql',
  '015_badge_cleanup.sql',
];

/** Deterministic fake checksum: identity-ish, so tests can reason about drift. */
const fakeChecksum = (f: string): string => `csum-${f}`;

const applied = (names: string[]): AppliedMigration[] =>
  names.map((filename) => ({ filename, checksum: fakeChecksum(filename) }));

const HEAD_PROBE: SchemaProbe = {
  users: true,
  quizQuestions: true,
  customMissions: true,
  childrenInterests: true,
};

describe('planMigrations', () => {
  it('fresh DB: empty ledger -> pending is every file, in sorted order', () => {
    const plan = planMigrations(FILES, [], fakeChecksum);
    expect(plan.pending).toEqual(FILES);
    expect(plan.drifted).toEqual([]);
    expect(plan.orphaned).toEqual([]);
  });

  it('tolerates the 004 gap with no error and preserves order', () => {
    expect(FILES).not.toContain('004_missing.sql');
    const plan = planMigrations(FILES, [], fakeChecksum);
    expect(plan.pending).toEqual(FILES);
    // order is exactly the input order — no reordering, no contiguity assertion
    expect(plan.pending[3]).toBe('003_usage_sessions.sql');
    expect(plan.pending[4]).toBe('005_add_tflite_risk.sql');
  });

  it('partial: 3 of 15 recorded -> pending is exactly the other 12, in order', () => {
    const recorded = ['000_init.sql', '001_screen_events.sql', '002_dev_seed.sql'];
    const plan = planMigrations(FILES, applied(recorded), fakeChecksum);
    expect(plan.pending).toEqual(FILES.slice(3));
    expect(plan.pending).toHaveLength(12);
    expect(plan.drifted).toEqual([]);
    expect(plan.orphaned).toEqual([]);
  });

  it('up to date: all recorded -> pending empty, drifted empty', () => {
    const plan = planMigrations(FILES, applied(FILES), fakeChecksum);
    expect(plan.pending).toEqual([]);
    expect(plan.drifted).toEqual([]);
    expect(plan.orphaned).toEqual([]);
  });

  it('drift detected: mismatched checksum -> in drifted with both values, not in pending', () => {
    const rows = applied(FILES);
    rows[10] = { filename: '011_quiz_questions.sql', checksum: 'OLD-hash' };
    const plan = planMigrations(FILES, rows, (f) =>
      f === '011_quiz_questions.sql' ? 'NEW-hash' : fakeChecksum(f),
    );
    expect(plan.drifted).toEqual([
      { filename: '011_quiz_questions.sql', recorded: 'OLD-hash', actual: 'NEW-hash' },
    ]);
    expect(plan.pending).toEqual([]);
  });

  it('orphaned: ledger row with no file on disk -> in orphaned, not pending', () => {
    const rows = applied([...FILES, '099_deleted.sql']);
    const plan = planMigrations(FILES, rows, fakeChecksum);
    expect(plan.orphaned).toEqual(['099_deleted.sql']);
    expect(plan.pending).toEqual([]);
    expect(plan.drifted).toEqual([]);
  });
});

describe('checksum normalisation', () => {
  const SQL_LF = 'CREATE TABLE t (\n  id UUID PRIMARY KEY,\n  name VARCHAR(255)\n);\n';

  it('is CRLF-insensitive: \\r\\n and \\n hash identically', () => {
    const sqlCrlf = SQL_LF.replace(/\n/g, '\r\n');
    expect(sqlCrlf).not.toBe(SQL_LF);
    expect(checksumSql(sqlCrlf)).toBe(checksumSql(SQL_LF));
  });

  it('is bare-CR-insensitive (old-Mac line endings)', () => {
    const sqlCr = SQL_LF.replace(/\n/g, '\r');
    expect(checksumSql(sqlCr)).toBe(checksumSql(SQL_LF));
  });

  it('is BOM-insensitive: a leading U+FEFF does not change the checksum', () => {
    expect(checksumSql('﻿' + SQL_LF)).toBe(checksumSql(SQL_LF));
  });

  it('ignores trailing whitespace at end of file only', () => {
    expect(checksumSql(SQL_LF + '\n\n  \t\n')).toBe(checksumSql(SQL_LF));
  });

  it('STILL catches a real content edit: VARCHAR(255) -> VARCHAR(256)', () => {
    const edited = SQL_LF.replace('VARCHAR(255)', 'VARCHAR(256)');
    expect(checksumSql(edited)).not.toBe(checksumSql(SQL_LF));
  });

  it('STILL catches an internal-whitespace edit (normalisation did not go too far)', () => {
    const edited = SQL_LF.replace('id UUID', 'id    UUID');
    expect(checksumSql(edited)).not.toBe(checksumSql(SQL_LF));
  });

  it('normalizeSql leaves interior content byte-for-byte apart from EOL/BOM/EOF', () => {
    expect(normalizeSql('-- a comment\r\nSELECT 1;\r\n')).toBe('-- a comment\nSELECT 1;');
  });
});

describe('decideStartupMode', () => {
  it('ledgerCount > 0 -> normal (regardless of probe)', () => {
    expect(decideStartupMode(1, HEAD_PROBE)).toBe('normal');
    expect(
      decideStartupMode(15, { users: false, quizQuestions: false, customMissions: false, childrenInterests: false }),
    ).toBe('normal');
  });

  it('empty ledger + no users table -> fresh', () => {
    expect(decideStartupMode(0, { ...HEAD_PROBE, users: false })).toBe('fresh');
  });

  it('empty ledger + users + all three landmarks -> baseline', () => {
    expect(decideStartupMode(0, HEAD_PROBE)).toBe('baseline');
  });

  it('empty ledger + users + a missing landmark -> ambiguous', () => {
    expect(decideStartupMode(0, { ...HEAD_PROBE, childrenInterests: false })).toBe('ambiguous');
  });

  it('boundary: users + quiz_questions present but custom_missions absent -> ambiguous, NOT baseline', () => {
    expect(
      decideStartupMode(0, {
        users: true,
        quizQuestions: true,
        customMissions: false,
        childrenInterests: true,
      }),
    ).toBe('ambiguous');
  });
});

describe('resolveBaselineUpTo', () => {
  it('stamps files up to and including target, runs the rest', () => {
    const { stamp, run } = resolveBaselineUpTo(FILES, '012_custom_missions.sql');
    expect(stamp).toEqual(FILES.slice(0, 12));
    expect(stamp[stamp.length - 1]).toBe('012_custom_missions.sql');
    expect(run).toEqual([
      '013_quiz_media_violence.sql',
      '014_child_interests.sql',
      '015_badge_cleanup.sql',
    ]);
    expect(stamp).not.toEqual(expect.arrayContaining(run));
  });

  it('target = last file -> stamp is everything, run is empty', () => {
    const { stamp, run } = resolveBaselineUpTo(FILES, '015_badge_cleanup.sql');
    expect(stamp).toEqual(FILES);
    expect(run).toEqual([]);
  });

  it('unknown target throws (a typo must not stamp the whole set)', () => {
    expect(() => resolveBaselineUpTo(FILES, '012_custom_mission.sql')).toThrow(/matches no migration file/);
    expect(() => resolveBaselineUpTo(FILES, 'nonsense')).toThrow();
  });

  it('override applies in the ambiguous case: a half-migrated DB can still be split', () => {
    // decideStartupMode would return 'ambiguous' here; the shell reads
    // MIGRATE_BASELINE_UPTO *before* the mode branch, so this split is what runs.
    const probe: SchemaProbe = {
      users: true,
      quizQuestions: true,
      customMissions: false,
      childrenInterests: false,
    };
    expect(decideStartupMode(0, probe)).toBe('ambiguous');
    const { stamp, run } = resolveBaselineUpTo(FILES, '011_quiz_questions.sql');
    expect(stamp).toContain('011_quiz_questions.sql');
    expect(run).toEqual([
      '012_custom_missions.sql',
      '013_quiz_media_violence.sql',
      '014_child_interests.sql',
      '015_badge_cleanup.sql',
    ]);
  });
});

describe('ordering convention', () => {
  it('lexicographic sort matches numeric intent for the zero-padded 3-digit scheme', () => {
    const shuffled = [...FILES].reverse();
    const sorted = [...shuffled].sort();
    expect(sorted).toEqual(FILES);
    // Regression guard: this holds ONLY because every prefix is a zero-padded
    // 3-digit number. A future unpadded "9_foo.sql" would sort BEFORE
    // "10_bar.sql" lexicographically and run out of numeric order — new
    // migrations must keep the NNN_ prefix.
    expect(['10_bar.sql', '9_foo.sql'].sort()).toEqual(['10_bar.sql', '9_foo.sql']);
  });
});
