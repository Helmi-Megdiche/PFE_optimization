import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { type Difficulty } from '../../missions/games/gameLogic';
import {
  applyAiMove,
  applyHumanMove,
  initialTttState,
} from '../../missions/games/tttTurn';
import { difficultyForGame, recordGameResult } from '../../missions/games/gameStats';
import type { GameProps } from './gameTypes';
import { scWarn } from '../../utils/screenCaptureLogger';
import { focus } from '../../theme';

/** Delay before the AI replies — reads as "thinking" and lets React commit the human move first. */
const AI_MOVE_DELAY_MS = 450;
/** Safety net: if the AI turn has not resolved this long after it began, force the move. */
const AI_STALL_RECOVERY_MS = 3_000;

export function TicTacToeGame({ metadata, age, onComplete }: GameProps): React.JSX.Element {
  const [state, setState] = useState(initialTttState);
  const [difficulty, setDifficulty] = useState<Difficulty>(
    (metadata.aiDifficulty as Difficulty) ?? 'medium',
  );
  const doneRef = useRef(false);

  useEffect(() => {
    if (metadata.aiDifficulty) {
      return;
    }
    void difficultyForGame('tictactoe', age).then(setDifficulty);
  }, [age, metadata.aiDifficulty]);

  // Drive the AI turn on its own tick. One scheduled move plus a stall watchdog;
  // both call the same guarded reducer, so a double fire is a harmless no-op. The
  // cleanup clears both whenever the phase changes, so the lock can never latch.
  useEffect(() => {
    if (state.phase !== 'ai') {
      return undefined;
    }
    const runAi = () => setState((s) => applyAiMove(s, difficulty));
    const move = setTimeout(runAi, AI_MOVE_DELAY_MS);
    const recover = setTimeout(() => {
      scWarn('[TicTacToe] AI turn stalled — forcing move', { difficulty });
      runAi();
    }, AI_STALL_RECOVERY_MS);
    return () => {
      clearTimeout(move);
      clearTimeout(recover);
    };
  }, [state.phase, difficulty]);

  useEffect(() => {
    if (doneRef.current || state.winner === null) {
      return;
    }
    doneRef.current = true;
    const childWon = state.winner === 'X';
    const draw = state.winner === 'draw';
    void recordGameResult('tictactoe', {
      score: childWon ? 100 : draw ? 50 : 0,
      highScore: childWon,
    });
    onComplete({ won: childWon, completed: true });
  }, [state.winner, onComplete]);

  const status = useMemo(() => {
    if (state.winner === 'X') {
      return 'You win! 🎉';
    }
    if (state.winner === 'draw') {
      return "It's a draw";
    }
    if (state.winner === 'O') {
      return 'AI wins';
    }
    return state.phase === 'ai' ? 'AI is thinking…' : 'Your turn (X)';
  }, [state.winner, state.phase]);

  const playerMove = (index: number) => {
    setState((s) => applyHumanMove(s, index));
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Tic-Tac-Toe</Text>
      <Text style={styles.sub}>Difficulty: {difficulty}</Text>
      <Text style={styles.status}>{status}</Text>
      <View style={styles.grid}>
        {state.board.map((cell, i) => (
          <Pressable key={i} style={styles.cell} onPress={() => playerMove(i)}>
            <Text style={[styles.mark, cell === 'O' && styles.markO]}>{cell ?? ''}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  title: { color: focus.text, fontSize: 22, fontWeight: '800' },
  sub: { color: focus.textMuted, marginTop: 4 },
  status: { color: focus.amber, fontSize: 16, marginTop: 12, fontWeight: '700' },
  grid: {
    marginTop: 20,
    width: 300,
    height: 300,
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: focus.surface,
    borderRadius: 18,
    overflow: 'hidden',
  },
  cell: {
    width: 100,
    height: 100,
    borderWidth: 1,
    borderColor: focus.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mark: { color: focus.accent, fontSize: 48, fontWeight: '800' },
  markO: { color: focus.coral },
});

export const gridLayout: {grid: ViewStyle; cell: ViewStyle} = {
  grid: styles.grid,
  cell: styles.cell,
};
