import {
  applyAiMove,
  applyHumanMove,
  initialTttState,
  tttMarkCounts,
  type TttState,
} from '../src/missions/games/tttTurn';
import type {TttBoard} from '../src/missions/games/gameLogic';

const st = (board: TttBoard, phase: TttState['phase']): TttState => ({
  board,
  phase,
  winner: null,
  moveSequence: [],
});

describe('tttTurn — turn lock', () => {
  it("ignores a tap while it is the AI's turn", () => {
    const afterHuman = applyHumanMove(initialTttState(), 0);
    expect(afterHuman.phase).toBe('ai');

    const spam = applyHumanMove(afterHuman, 4);
    expect(spam).toBe(afterHuman); // unchanged reference — no-op
    expect(tttMarkCounts(spam.board)).toEqual({x: 1, o: 0});
  });

  it('ignores a tap once the game is over', () => {
    const over: TttState = {
      board: ['X', 'X', 'X', null, null, null, null, null, null],
      phase: 'over',
      winner: 'X',
      moveSequence: [0, 1, 2],
    };
    const after = applyHumanMove(over, 5);
    expect(after.phase).toBe('over');
    expect(tttMarkCounts(after.board)).toEqual({x: 3, o: 0});
  });

  it('ignores a tap on an occupied cell', () => {
    const s = applyHumanMove(initialTttState(), 0); // X at 0, phase ai
    const back = applyAiMove(s, 'medium'); // O at centre, phase human
    const onOccupied = applyHumanMove(back, 0);
    expect(onOccupied).toBe(back);
  });

  it('clears the lock after the AI moves — the next human tap is accepted', () => {
    const s1 = applyHumanMove(initialTttState(), 0);
    const s2 = applyAiMove(s1, 'medium');
    expect(s2.phase).toBe('human');
    expect(tttMarkCounts(s2.board)).toEqual({x: 1, o: 1});

    const s3 = applyHumanMove(s2, 1);
    expect(s3.phase).toBe('ai');
    expect(tttMarkCounts(s3.board)).toEqual({x: 2, o: 1});
  });

  it('clears the lock on a human win (phase over)', () => {
    const s = st(['X', 'X', null, 'O', 'O', null, null, null, null], 'human');
    const win = applyHumanMove(s, 2);
    expect(win.winner).toBe('X');
    expect(win.phase).toBe('over');
  });

  it('clears the lock on an AI win (phase over)', () => {
    const s = st(['O', 'O', null, 'X', 'X', null, 'X', null, null], 'ai');
    const win = applyAiMove(s, 'medium'); // O completes the top row at 2
    expect(win.board[2]).toBe('O');
    expect(win.winner).toBe('O');
    expect(win.phase).toBe('over');
  });

  it('clears the lock on a draw (phase over)', () => {
    const s = st(['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', null], 'human');
    const draw = applyHumanMove(s, 8);
    expect(draw.winner).toBe('draw');
    expect(draw.phase).toBe('over');
  });
});

describe('tttTurn — move-count invariant', () => {
  it('never lets |X| - |O| reach 2 through a full played-out game (with tap spam)', () => {
    let state = initialTttState();

    for (let step = 0; step < 30 && state.phase !== 'over'; step += 1) {
      if (state.phase === 'human') {
        const target = state.board.findIndex(c => c === null);
        state = applyHumanMove(state, target);
        state = applyHumanMove(state, target); // duplicate tap — no-op
        const other = state.board.findIndex(c => c === null);
        if (other >= 0) {
          state = applyHumanMove(state, other); // it is the AI's turn now — no-op
        }
      } else {
        state = applyAiMove(state, 'hard');
      }
      const {x, o} = tttMarkCounts(state.board);
      expect(x - o).toBeGreaterThanOrEqual(0);
      expect(x - o).toBeLessThanOrEqual(1);
    }

    expect(state.phase).toBe('over');
  });

  it('spamming human moves during the AI turn cannot push the diff past 1', () => {
    let state = applyHumanMove(initialTttState(), 0); // phase ai, X=1 O=0
    for (let i = 0; i < 9; i += 1) {
      state = applyHumanMove(state, i);
    }
    expect(tttMarkCounts(state.board)).toEqual({x: 1, o: 0});
    expect(state.phase).toBe('ai');
  });
});

describe('tttTurn — AI-stall recovery', () => {
  it('applyAiMove always advances a state stuck in the AI phase (the 3s watchdog payload)', () => {
    const stalled = st(
      ['X', null, null, null, 'X', null, null, null, null],
      'ai',
    );
    const recovered = applyAiMove(stalled, 'hard');
    expect(recovered.phase).not.toBe('ai');
    expect(tttMarkCounts(recovered.board).o).toBe(1); // an O was placed
  });

  it('resolves instead of stalling when the board is already full', () => {
    const full = st(['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X'], 'ai');
    const out = applyAiMove(full, 'hard');
    expect(out.phase).toBe('over');
    expect(out.winner).toBe('draw');
  });

  it('is idempotent — a second (watchdog) call after it resolved is a no-op', () => {
    const s1 = applyHumanMove(initialTttState(), 0);
    const s2 = applyAiMove(s1, 'medium'); // phase human
    const s3 = applyAiMove(s2, 'medium'); // watchdog double-fire
    expect(s3).toBe(s2);
  });
});

describe('tttTurn — AI move never corrupts the board', () => {
  it('does not append an O when the board is already won', () => {
    const s = st(['X', 'X', 'X', 'O', 'O', null, null, null, null], 'ai');
    const out = applyAiMove(s, 'hard');
    expect(tttMarkCounts(out.board)).toEqual({x: 3, o: 2});
    expect(out.phase).toBe('over');
    expect(out.winner).toBe('X');
  });
});

/** Replays a move sequence onto an empty board, alternating X (first) / O — mirrors the
 * backend's server-side replay validator (ALL_IS_FIXED #51 Part B) so this test pins the
 * same invariant client-side. */
function replayMoveSequence(moveSequence: number[]): TttBoard {
  const board: TttBoard = [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];
  moveSequence.forEach((index, i) => {
    board[index] = i % 2 === 0 ? 'X' : 'O';
  });
  return board;
}

describe('tttTurn — moveSequence (ALL_IS_FIXED #51)', () => {
  it('accumulates in play order across a human/AI exchange', () => {
    const s1 = applyHumanMove(initialTttState(), 4);
    expect(s1.moveSequence).toEqual([4]);

    const s2 = applyAiMove(s1, 'medium');
    expect(s2.moveSequence.length).toBe(2);
    expect(s2.moveSequence[0]).toBe(4);

    const s3 = applyHumanMove(s2, 0);
    expect(s3.moveSequence.length).toBe(3);
    expect(s3.moveSequence.slice(0, 2)).toEqual(s2.moveSequence);
  });

  it('does not record a no-op tap (occupied cell, wrong turn, or game over)', () => {
    const s1 = applyHumanMove(initialTttState(), 0); // phase ai
    const spam = applyHumanMove(s1, 4); // human's turn lock — no-op
    expect(spam.moveSequence).toEqual(s1.moveSequence);

    const s2 = applyAiMove(s1, 'medium');
    const onOccupied = applyHumanMove(s2, 0);
    expect(onOccupied.moveSequence).toEqual(s2.moveSequence);
  });

  it('replaying the recorded moveSequence onto an empty board reproduces the final board exactly', () => {
    let state = initialTttState();
    for (let step = 0; step < 9 && state.phase !== 'over'; step += 1) {
      if (state.phase === 'human') {
        const target = state.board.findIndex(c => c === null);
        state = applyHumanMove(state, target);
      } else {
        state = applyAiMove(state, 'medium');
      }
    }
    expect(state.phase).toBe('over');
    expect(replayMoveSequence(state.moveSequence)).toEqual(state.board);
  });

  it('a played-to-a-win game leaves empty cells in both board and moveSequence length (not every cell played)', () => {
    // X: 0,1,2 (top row) — a 5-move win, 4 cells left empty.
    const s = st(['X', 'X', null, 'O', 'O', null, null, null, null], 'human');
    const withHistory: TttState = {...s, moveSequence: [0, 3, 1, 4]};
    const win = applyHumanMove(withHistory, 2);
    expect(win.winner).toBe('X');
    expect(win.moveSequence).toEqual([0, 3, 1, 4, 2]);
    expect(win.moveSequence.length).toBe(5);
    expect(win.board.filter(c => c === null).length).toBe(4);
  });
});
