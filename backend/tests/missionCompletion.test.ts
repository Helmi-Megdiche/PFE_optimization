import { evaluateMissionCompletion } from '../src/services/missionCompletion';

describe('evaluateMissionCompletion', () => {
  it('scores nback proportionally to exerciseScore', () => {
    const result = evaluateMissionCompletion(
      'cognitive',
      { exercise: 'nback' },
      30,
      { exerciseScore: 80 },
    );
    expect(result.success).toBe(true);
    expect(result.pointsAwarded).toBe(24);
  });

  it('scores reaction time with tiered points', () => {
    const fast = evaluateMissionCompletion(
      'cognitive',
      { exercise: 'reaction' },
      25,
      { reactionTimeMs: 250 },
    );
    const slow = evaluateMissionCompletion(
      'cognitive',
      { exercise: 'reaction' },
      25,
      { reactionTimeMs: 600 },
    );
    expect(fast.pointsAwarded).toBe(25);
    expect(slow.pointsAwarded).toBe(12);
  });

  it('awards bonus for optimal Tower of Hanoi moves', () => {
    const result = evaluateMissionCompletion(
      'cognitive',
      { exercise: 'hanoi', disks: 3 },
      40,
      { moves: 7 },
    );
    expect(result.success).toBe(true);
    expect(result.pointsAwarded).toBe(50);
    expect(result.completionData.optimal).toBe(true);
  });

  it('validates quiz answers with pass threshold', () => {
    const pass = evaluateMissionCompletion(
      'quiz',
      { correctAnswers: ['A', 'B', 'A'] },
      30,
      { answers: ['A', 'B', 'C'] },
    );
    expect(pass.success).toBe(true);
    expect(pass.pointsAwarded).toBeGreaterThan(0);

    const fail = evaluateMissionCompletion(
      'quiz',
      { correctAnswers: ['A', 'B', 'A'] },
      30,
      { answers: ['C', 'C', 'C'] },
    );
    expect(fail.success).toBe(false);
  });

  it('requires confirmation for real-world missions', () => {
    const ok = evaluateMissionCompletion(
      'real_world',
      { action: 'jumping_jacks' },
      20,
      { confirmed: true },
    );
    const no = evaluateMissionCompletion(
      'real_world',
      { action: 'jumping_jacks' },
      20,
      { confirmed: false },
    );
    expect(ok.pointsAwarded).toBe(20);
    expect(no.success).toBe(false);
  });
});

describe('evaluateMissionCompletion — minigame (tictactoe, ALL_IS_FIXED #51)', () => {
  const basePoints = 20;
  const meta = { game: 'tictactoe' };

  it('a legitimate win succeeds with the server-derived outcome — the shortest possible case (5 moves, 4 empty cells), since a win normally leaves cells empty, not the rare full-board case (D7)', () => {
    // X: 0, 1, 2 (top row) — O: 3, 4.
    const result = evaluateMissionCompletion('minigame', meta, basePoints, {
      moveSequence: [0, 3, 1, 4, 2],
      finalBoard: ['X', 'X', 'X', 'O', 'O', '', '', '', ''],
    });
    expect(result.success).toBe(true);
    expect(result.pointsAwarded).toBe(basePoints);
    expect(result.completionData).toMatchObject({ game: 'tictactoe', outcome: 'X' });
  });

  it('a legitimate loss succeeds too (D3 — existing behavior made explicit, not new scoring policy)', () => {
    // O wins the middle row (3, 4, 5).
    const result = evaluateMissionCompletion('minigame', meta, basePoints, {
      moveSequence: [0, 3, 1, 4, 6, 5],
      finalBoard: ['X', 'X', '', 'O', 'O', 'O', 'X', '', ''],
    });
    expect(result.success).toBe(true);
    expect(result.pointsAwarded).toBe(basePoints);
    expect(result.completionData.outcome).toBe('O');
  });

  it('a legitimate draw succeeds', () => {
    const result = evaluateMissionCompletion('minigame', meta, basePoints, {
      moveSequence: [0, 4, 8, 1, 2, 6, 3, 5, 7],
      finalBoard: ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X'],
    });
    expect(result.success).toBe(true);
    expect(result.pointsAwarded).toBe(basePoints);
    expect(result.completionData.outcome).toBe('draw');
  });

  it('an empty/missing board is refused with zero points', () => {
    const result = evaluateMissionCompletion('minigame', meta, basePoints, {});
    expect(result.success).toBe(false);
    expect(result.pointsAwarded).toBe(0);
  });

  it('a non-terminal board is refused with zero points', () => {
    const result = evaluateMissionCompletion('minigame', meta, basePoints, {
      moveSequence: [0],
      finalBoard: ['X', '', '', '', '', '', '', '', ''],
    });
    expect(result.success).toBe(false);
    expect(result.pointsAwarded).toBe(0);
  });

  it('a moveSequence that does not replay to the claimed finalBoard is refused with zero points', () => {
    const result = evaluateMissionCompletion('minigame', meta, basePoints, {
      moveSequence: [0, 1, 2, 3],
      finalBoard: ['X', 'X', 'X', 'O', 'O', '', '', '', ''],
    });
    expect(result.success).toBe(false);
    expect(result.pointsAwarded).toBe(0);
  });

  it('an illegal moveSequence (repeated cell) is refused with zero points', () => {
    const result = evaluateMissionCompletion('minigame', meta, basePoints, {
      moveSequence: [0, 4, 0],
      finalBoard: ['X', '', '', '', 'O', '', '', '', ''],
    });
    expect(result.success).toBe(false);
    expect(result.pointsAwarded).toBe(0);
  });

  it('an illegal moveSequence (out-of-range index) is refused with zero points', () => {
    const result = evaluateMissionCompletion('minigame', meta, basePoints, {
      moveSequence: [9],
      finalBoard: ['', '', '', '', '', '', '', '', ''],
    });
    expect(result.success).toBe(false);
    expect(result.pointsAwarded).toBe(0);
  });

  it('{won: true} alone, no evidence — the #48 regression test — is refused with zero points', () => {
    const result = evaluateMissionCompletion('minigame', meta, basePoints, { won: true });
    expect(result.success).toBe(false);
    expect(result.pointsAwarded).toBe(0);
  });

  it('the in-app surface sends the identical payload shape and gets the identical result — no surface-specific branching', () => {
    const result = evaluateMissionCompletion('minigame', meta, basePoints, {
      won: true,
      completed: true, // fields the in-app game also sends alongside the evidence
      moveSequence: [0, 3, 1, 4, 2],
      finalBoard: ['X', 'X', 'X', 'O', 'O', '', '', '', ''],
    });
    expect(result.success).toBe(true);
    expect(result.pointsAwarded).toBe(basePoints);
    expect(result.completionData.outcome).toBe('X');
  });

  it('sudoku (a different minigame) is unaffected — still the old trust-the-client path', () => {
    const result = evaluateMissionCompletion(
      'minigame',
      { game: 'sudoku' },
      basePoints,
      { won: true },
    );
    expect(result.success).toBe(true);
    expect(result.pointsAwarded).toBe(basePoints);
  });
});
