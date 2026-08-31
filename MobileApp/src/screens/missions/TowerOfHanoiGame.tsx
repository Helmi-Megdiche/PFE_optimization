import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  hanoiCanMove,
  hanoiMinMoves,
  hanoiMove,
  hanoiSolved,
  initialHanoi,
  type HanoiPegs,
} from '../../missions/games/gameLogic';
import { recordGameResult } from '../../missions/games/gameStats';
import type { GameProps } from './gameTypes';
import { focus } from '../../theme';

export function TowerOfHanoiGame({ metadata, onComplete }: GameProps): React.JSX.Element {
  const disks = Math.max(2, Math.min(4, Number(metadata.disks ?? 3)));
  const [pegs, setPegs] = useState<HanoiPegs>(() => initialHanoi(disks));
  const [selected, setSelected] = useState<number | null>(null);
  const [moves, setMoves] = useState(0);
  const [done, setDone] = useState(false);

  const onPeg = (peg: number) => {
    if (done) {
      return;
    }
    if (selected == null) {
      if (pegs[peg].length > 0) setSelected(peg);
      return;
    }
    if (selected === peg) {
      setSelected(null);
      return;
    }
    if (hanoiCanMove(pegs, selected, peg)) {
      const next = hanoiMove(pegs, selected, peg);
      const moveCount = moves + 1;
      setPegs(next);
      setMoves(moveCount);
      setSelected(null);
      if (hanoiSolved(next, disks)) {
        setDone(true);
        const optimal = moveCount <= hanoiMinMoves(disks);
        void recordGameResult('hanoi', {
          score: optimal ? 100 : Math.round((hanoiMinMoves(disks) / moveCount) * 100),
          highScore: optimal,
        });
        onComplete({ moves: moveCount });
      }
    } else {
      setSelected(null);
    }
  };

  const maxDisk = disks;
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Tower of Hanoi</Text>
      <Text style={styles.sub}>
        Move all disks to the right peg. Optimal: {hanoiMinMoves(disks)} moves.
      </Text>
      <Text style={styles.moves}>Moves: {moves}{done ? ' · Solved! 🎉' : ''}</Text>
      <View style={styles.board}>
        {[0, 1, 2].map((peg) => (
          <Pressable key={peg} style={styles.pegCol} onPress={() => onPeg(peg)}>
            <View style={styles.diskStack}>
              {pegs[peg].map((disk, i) => (
                <View
                  key={`${peg}-${i}`}
                  style={[
                    styles.disk,
                    {
                      width: 30 + (disk / maxDisk) * 80,
                      backgroundColor: DISK_COLORS[(disk - 1) % DISK_COLORS.length],
                    },
                  ]}
                />
              ))}
            </View>
            <View style={[styles.peg, selected === peg && styles.pegSelected]} />
            <Text style={styles.pegLabel}>{peg === 2 ? 'Target' : `Peg ${peg + 1}`}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const DISK_COLORS = focus.disks;

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  title: { color: focus.text, fontSize: 22, fontWeight: '800' },
  sub: { color: focus.textMuted, marginTop: 6, textAlign: 'center', paddingHorizontal: 16 },
  moves: { color: focus.amber, marginTop: 12, fontWeight: '700' },
  board: { flexDirection: 'row', marginTop: 24, height: 220, alignItems: 'flex-end' },
  pegCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  diskStack: { alignItems: 'center', justifyContent: 'flex-end', flex: 1 },
  disk: { height: 22, borderRadius: 6, marginVertical: 2 },
  peg: { width: 8, height: 12, backgroundColor: focus.border, borderRadius: 2 },
  pegSelected: { backgroundColor: focus.accent },
  pegLabel: { color: focus.textMuted, marginTop: 6, fontSize: 12 },
});
