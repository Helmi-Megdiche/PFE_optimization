import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { quizSelectionsToLetters } from '../../missions/games/gameLogic';
import { resolveQuizQuestions } from '../../missions/games/quizBank';
import type { GameProps } from './gameTypes';
import { focus } from '../../theme';

export function QuizScreen({ metadata, onComplete }: GameProps): React.JSX.Element {
  const questions = useMemo(() => resolveQuizQuestions(metadata), [metadata]);
  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState<number[]>([]);

  const question = questions[current];

  const choose = (optionIndex: number) => {
    const next = [...answers, optionIndex];
    setAnswers(next);
    if (current + 1 >= questions.length) {
      onComplete({ answers: quizSelectionsToLetters(next) });
    } else {
      setCurrent((c) => c + 1);
    }
  };

  if (!question) {
    return <Text style={styles.sub}>No questions available.</Text>;
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.progressWrap}>
        <View style={styles.progressTrack}>
          <View
            style={[styles.progressFill, { width: `${((current + 1) / questions.length) * 100}%` }]}
          />
        </View>
        <Text style={styles.progress}>
          Question {current + 1} of {questions.length}
        </Text>
      </View>
      <Text style={styles.question}>{question.text}</Text>
      <View style={styles.options}>
        {question.options.map((opt, i) => (
          <Pressable
            key={i}
            style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
            onPress={() => choose(i)}>
            <View style={styles.optionLetterWrap}>
              <Text style={styles.optionLetter}>{String.fromCharCode(65 + i)}</Text>
            </View>
            <Text style={styles.optionText}>{opt}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch' },
  progressWrap: { gap: 8 },
  progressTrack: {
    height: 6,
    borderRadius: 6,
    backgroundColor: focus.surface,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 6, backgroundColor: focus.accent },
  progress: { color: focus.textMuted, textAlign: 'center', fontSize: 13, fontWeight: '600' },
  sub: { color: focus.textMuted, textAlign: 'center' },
  question: {
    color: focus.text,
    fontSize: 21,
    fontWeight: '800',
    marginTop: 20,
    textAlign: 'center',
    lineHeight: 28,
  },
  options: { marginTop: 28 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: focus.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: focus.border,
    padding: 16,
    marginBottom: 12,
  },
  optionPressed: { backgroundColor: focus.surfaceAlt, borderColor: focus.accent },
  optionLetterWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: focus.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionLetter: { color: focus.accent, fontSize: 16, fontWeight: '800' },
  optionText: { color: focus.text, fontSize: 16, flex: 1, lineHeight: 22 },
});
