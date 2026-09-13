import {buildCompletionPayload} from '../src/missions/missionCompletion';

describe('buildCompletionPayload', () => {
  it('real_world always confirms', () => {
    expect(buildCompletionPayload('real_world', {})).toEqual({confirmed: true});
  });

  it('quiz forwards submittedAnswers when present', () => {
    expect(
      buildCompletionPayload('quiz', {submittedAnswers: ['A', 'B', 'C']}),
    ).toEqual({answers: ['A', 'B', 'C']});
  });

  it('quiz falls back to metadata.answers, then an empty array', () => {
    expect(buildCompletionPayload('quiz', {answers: ['A']})).toEqual({
      answers: ['A'],
    });
    expect(buildCompletionPayload('quiz', {})).toEqual({answers: []});
  });

  it('cognitive dispatches per exercise', () => {
    expect(buildCompletionPayload('cognitive', {exercise: 'reaction'})).toEqual(
      {
        reactionTimeMs: 250,
      },
    );
    expect(buildCompletionPayload('cognitive', {exercise: 'hanoi'})).toEqual({
      moves: 7,
    });
    expect(buildCompletionPayload('cognitive', {exercise: 'nback'})).toEqual({
      exerciseScore: 100,
    });
  });

  it('default falls back to confirmed', () => {
    expect(buildCompletionPayload('something_unknown', {})).toEqual({
      confirmed: true,
    });
  });

  describe('minigame', () => {
    it('forwards real tictactoe evidence when present', () => {
      const metadata = {
        game: 'tictactoe',
        finalBoard: ['X', 'X', 'X', '', '', '', '', '', ''],
        moveSequence: [0, 3, 1, 4, 2],
      };
      expect(buildCompletionPayload('minigame', metadata)).toEqual({
        finalBoard: metadata.finalBoard,
        moveSequence: metadata.moveSequence,
      });
    });

    it('tictactoe without evidence returns {} — never a fabricated won:true (D4b)', () => {
      expect(buildCompletionPayload('minigame', {game: 'tictactoe'})).toEqual(
        {},
      );
    });

    it('sudoku (or any other minigame) keeps the unchanged won:true trust model', () => {
      expect(buildCompletionPayload('minigame', {game: 'sudoku'})).toEqual({
        won: true,
      });
      expect(buildCompletionPayload('minigame', {})).toEqual({won: true});
    });
  });
});
