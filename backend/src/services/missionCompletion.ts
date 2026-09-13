export interface MissionCompletionPayload {
  exerciseScore?: number;
  reactionTimeMs?: number;
  moves?: number;
  answers?: string[];
  won?: boolean;
  completed?: boolean;
  confirmed?: boolean;
  /** Tic-Tac-Toe evidence (ALL_IS_FIXED #51) — replayed and verified, never trusted as-is. */
  finalBoard?: string[];
  moveSequence?: number[];
}

export interface MissionCompletionResult {
  success: boolean;
  pointsAwarded: number;
  completionData: Record<string, unknown>;
  error?: string;
}

function minimumHanoiMoves(disks: number): number {
  return Math.pow(2, disks) - 1;
}

function scoreNback(basePoints: number, exerciseScore: number): number {
  const clamped = Math.max(0, Math.min(100, exerciseScore));
  return Math.floor((basePoints * clamped) / 100);
}

function scoreReaction(basePoints: number, reactionTimeMs: number): number {
  if (reactionTimeMs <= 300) {
    return basePoints;
  }
  if (reactionTimeMs <= 500) {
    return Math.floor(basePoints * 0.75);
  }
  return Math.floor(basePoints * 0.5);
}

function scoreHanoi(
  basePoints: number,
  moves: number,
  disks: number,
): { points: number; optimal: boolean } {
  const minMoves = minimumHanoiMoves(disks);
  if (moves <= minMoves) {
    return { points: basePoints + 10, optimal: true };
  }
  const ratio = minMoves / moves;
  return {
    points: Math.max(5, Math.floor(basePoints * ratio)),
    optimal: false,
  };
}

// Tic-Tac-Toe replay (ALL_IS_FIXED #51 Part B) — mirrors the client state machine
// (MobileApp/src/missions/games/gameLogic.ts's TTT_LINES/tttWinner) exactly. Empty cell = ''
// (not null), matching Java and the Joi schema (see missions.validator.ts's comment on why
// Joi.string() is avoided).
const TTT_LINES: number[][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

type TttMark = 'X' | 'O' | '';

function tttWinnerServer(board: TttMark[]): 'X' | 'O' | 'draw' | null {
  for (const [a, b, c] of TTT_LINES) {
    if (board[a] !== '' && board[a] === board[b] && board[a] === board[c]) {
      return board[a] as 'X' | 'O';
    }
  }
  // A terminal board is not usually full — a win normally leaves cells empty (a 5-move win
  // leaves 4); only a draw fills all 9. Checked last, and only once no line matched.
  if (board.every((cell) => cell !== '')) {
    return 'draw';
  }
  return null;
}

interface TttReplayResult {
  valid: boolean;
  outcome?: 'X' | 'O' | 'draw';
  reason?: string;
}

/**
 * Replays a claimed moveSequence onto an empty board and checks it against a claimed
 * finalBoard — the server never trusts payload.won, it derives the outcome itself. Refuses
 * (does not throw) on any fabrication: missing evidence, an illegal move, moves continuing
 * past a decided position, a board that doesn't match the replay, or a non-terminal result.
 */
function replayTicTacToe(
  moveSequence: number[] | undefined,
  finalBoard: string[] | undefined,
): TttReplayResult {
  if (!Array.isArray(moveSequence) || moveSequence.length === 0) {
    return { valid: false, reason: 'moveSequence required' };
  }
  if (!Array.isArray(finalBoard) || finalBoard.length !== 9) {
    return { valid: false, reason: 'finalBoard required (9 cells)' };
  }

  const board: TttMark[] = ['', '', '', '', '', '', '', '', ''];
  for (let i = 0; i < moveSequence.length; i += 1) {
    const index = moveSequence[i];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 8) {
      return { valid: false, reason: `illegal move index at step ${i}` };
    }
    if (board[index] !== '') {
      return { valid: false, reason: `move ${i} lands on an already-occupied cell` };
    }
    board[index] = i % 2 === 0 ? 'X' : 'O'; // X (child) moves first, alternating with O (AI)

    const isLastMove = i === moveSequence.length - 1;
    if (!isLastMove && tttWinnerServer(board) !== null) {
      return { valid: false, reason: 'moves continued after the game was already decided' };
    }
  }

  for (let i = 0; i < 9; i += 1) {
    const claimed = finalBoard[i] === 'X' || finalBoard[i] === 'O' ? finalBoard[i] : '';
    if (claimed !== board[i]) {
      return { valid: false, reason: 'replayed board does not match finalBoard' };
    }
  }

  const outcome = tttWinnerServer(board);
  if (outcome === null) {
    return { valid: false, reason: 'final position is not terminal' };
  }
  return { valid: true, outcome };
}

function scoreQuiz(
  basePoints: number,
  answers: string[],
  correctAnswers: string[],
): { points: number; passed: boolean } {
  let correct = 0;
  for (let i = 0; i < correctAnswers.length; i += 1) {
    if (answers[i] === correctAnswers[i]) {
      correct += 1;
    }
  }
  const passed = correct >= Math.ceil(correctAnswers.length * (2 / 3));
  const ratio = correct / correctAnswers.length;
  return {
    points: passed ? Math.floor(basePoints * ratio) : Math.floor(basePoints * 0.25),
    passed,
  };
}

export function evaluateMissionCompletion(
  missionType: string,
  metadata: Record<string, unknown>,
  basePoints: number,
  payload: MissionCompletionPayload,
): MissionCompletionResult {
  if (missionType === 'cognitive') {
    const exercise = metadata.exercise as string | undefined;
    if (exercise === 'nback') {
      if (payload.exerciseScore == null) {
        return {
          success: false,
          pointsAwarded: 0,
          completionData: {},
          error: 'exerciseScore required for nback',
        };
      }
      const pointsAwarded = scoreNback(basePoints, payload.exerciseScore);
      return {
        success: pointsAwarded > 0,
        pointsAwarded,
        completionData: {
          exercise: 'nback',
          exerciseScore: payload.exerciseScore,
        },
      };
    }
    if (exercise === 'reaction') {
      if (payload.reactionTimeMs == null) {
        return {
          success: false,
          pointsAwarded: 0,
          completionData: {},
          error: 'reactionTimeMs required for reaction',
        };
      }
      const pointsAwarded = scoreReaction(basePoints, payload.reactionTimeMs);
      return {
        success: true,
        pointsAwarded,
        completionData: {
          exercise: 'reaction',
          reactionTimeMs: payload.reactionTimeMs,
        },
      };
    }
    if (exercise === 'hanoi') {
      if (payload.moves == null) {
        return {
          success: false,
          pointsAwarded: 0,
          completionData: {},
          error: 'moves required for hanoi',
        };
      }
      const disks = Number(metadata.disks ?? 3);
      const { points, optimal } = scoreHanoi(basePoints, payload.moves, disks);
      return {
        success: true,
        pointsAwarded: points,
        completionData: {
          exercise: 'hanoi',
          moves: payload.moves,
          optimal,
          minMoves: minimumHanoiMoves(disks),
        },
      };
    }
  }

  if (missionType === 'quiz') {
    const correctAnswers = (metadata.correctAnswers as string[] | undefined) ?? [
      'A',
      'B',
      'A',
    ];
    if (!payload.answers || payload.answers.length === 0) {
      return {
        success: false,
        pointsAwarded: 0,
        completionData: {},
        error: 'answers required for quiz',
      };
    }
    const { points, passed } = scoreQuiz(basePoints, payload.answers, correctAnswers);
    return {
      success: passed,
      pointsAwarded: points,
      completionData: {
        answers: payload.answers,
        passed,
      },
      error: passed ? undefined : 'Quiz not passed',
    };
  }

  if (missionType === 'minigame') {
    if (metadata.game === 'tictactoe') {
      // Replay-verified path (ALL_IS_FIXED #51 / #48) — applies identically regardless of
      // which surface completed it (native overlay or in-app MissionScreen both send the
      // same finalBoard/moveSequence shape). payload.won is never read; the outcome below is
      // derived entirely from the verified replay. A refusal here means fabrication (a bad
      // board/sequence), a different failure class from "didn't finish" below — so it gets
      // its own zero-points return, not the generic branch's 25%-partial-credit fallback.
      const replay = replayTicTacToe(payload.moveSequence, payload.finalBoard);
      if (!replay.valid) {
        return {
          success: false,
          pointsAwarded: 0,
          completionData: {},
          error: replay.reason ?? 'Tic-Tac-Toe completion could not be verified',
        };
      }
      // Win, loss, or draw all succeed — a legitimately played terminal board is the bar,
      // not a win (this is existing behavior made explicit, not new scoring policy: the
      // in-app game already sent `completed: true` on every terminal board and this same
      // branch already treated that as full success; only the outcome's *proof* is new).
      return {
        success: true,
        pointsAwarded: basePoints,
        completionData: {
          game: 'tictactoe',
          outcome: replay.outcome,
          finalBoard: payload.finalBoard,
        },
      };
    }

    const success = payload.won === true || payload.completed === true;
    return {
      success,
      pointsAwarded: success ? basePoints : Math.floor(basePoints * 0.25),
      completionData: {
        won: payload.won ?? false,
        completed: payload.completed ?? false,
      },
      error: success ? undefined : 'Minigame not completed',
    };
  }

  if (missionType === 'real_world') {
    const success = payload.confirmed === true;
    return {
      success,
      pointsAwarded: success ? basePoints : 0,
      completionData: { confirmed: payload.confirmed ?? false },
      error: success ? undefined : 'Real-world mission requires confirmation',
    };
  }

  return {
    success: false,
    pointsAwarded: 0,
    completionData: {},
    error: `Unknown mission type: ${missionType}`,
  };
}
