/**
 * Pure turn/board state machine for the Tic-Tac-Toe mission mini-game.
 *
 * No React / native imports — testable with plain Jest. The component is a thin
 * shell over this: it renders `state.board`, forwards taps to `applyHumanMove`,
 * and schedules `applyAiMove` on its own tick.
 *
 * The `phase` field is the turn lock: `applyHumanMove` is a no-op unless it is the
 * human's turn, so a tap that lands while the AI is still "thinking" is dropped
 * instead of committing a second X against a stale board. Invariant: after any
 * exchange `|X| - |O|` is 0 or 1, never 2.
 */
import {
  tttAiMove,
  tttWinner,
  type Difficulty,
  type TttBoard,
} from './gameLogic';

export type TttPhase = 'human' | 'ai' | 'over';
export type TttResult = 'X' | 'O' | 'draw';

export interface TttState {
  board: TttBoard;
  phase: TttPhase;
  winner: TttResult | null;
  /** Cell indices played, in order — the evidence a completion is later replayed against. */
  moveSequence: number[];
}

const EMPTY_BOARD: TttBoard = [
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

export function initialTttState(): TttState {
  return {
    board: [...EMPTY_BOARD],
    phase: 'human',
    winner: null,
    moveSequence: [],
  };
}

/** Mark tally — used by the component's status text and by the test invariants. */
export function tttMarkCounts(board: TttBoard): {x: number; o: number} {
  let x = 0;
  let o = 0;
  for (const cell of board) {
    if (cell === 'X') {
      x += 1;
    } else if (cell === 'O') {
      o += 1;
    }
  }
  return {x, o};
}

function decided(board: TttBoard): TttResult | null {
  const w = tttWinner(board);
  return w === 'X' || w === 'O' || w === 'draw' ? w : null;
}

/** Fold a board into a state: over if it is decided, otherwise `next` to play. */
function resolve(
  board: TttBoard,
  next: TttPhase,
  moveSequence: number[],
): TttState {
  const w = decided(board);
  return w
    ? {board, phase: 'over', winner: w, moveSequence}
    : {board, phase: next, winner: null, moveSequence};
}

/**
 * Commit the child's move at `index`. Returns the state unchanged (the turn lock)
 * unless it is the human's turn, the game is live, and the cell is empty.
 */
export function applyHumanMove(state: TttState, index: number): TttState {
  if (state.phase === 'over' || state.winner !== null) {
    return state;
  }
  const pre = decided(state.board);
  if (pre) {
    return {
      board: state.board,
      phase: 'over',
      winner: pre,
      moveSequence: state.moveSequence,
    };
  }
  if (state.phase !== 'human') {
    return state;
  }
  if (index < 0 || index > 8 || state.board[index] !== null) {
    return state;
  }
  const board = [...state.board];
  board[index] = 'X';
  return resolve(board, 'ai', [...state.moveSequence, index]);
}

/**
 * Apply the AI's ('O') reply. No-op unless it is the AI's turn. If the board is
 * already decided it resolves to `over`; if the AI cannot produce a legal move
 * the turn is handed back to the human — the board is never left stuck.
 */
export function applyAiMove(state: TttState, difficulty: Difficulty): TttState {
  if (state.phase !== 'ai') {
    return state;
  }
  const pre = decided(state.board);
  if (pre) {
    return {
      board: state.board,
      phase: 'over',
      winner: pre,
      moveSequence: state.moveSequence,
    };
  }
  const aiIndex = tttAiMove(state.board, difficulty);
  if (aiIndex < 0 || aiIndex > 8 || state.board[aiIndex] != null) {
    return resolve(state.board, 'human', state.moveSequence);
  }
  const board = [...state.board];
  board[aiIndex] = 'O';
  return resolve(board, 'human', [...state.moveSequence, aiIndex]);
}
