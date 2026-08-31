/**
 * SafeGuard UI primitives — the shared vocabulary every screen is built from.
 * All styling derives from `../../theme`; screens compose these, not raw Views.
 */
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  PressableProps,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radius, shadow, spacing, type } from '../../theme';

/* ------------------------------------------------------------------ Screen */

/** Warm-sand page scaffold with consistent gutters. Scrollable by default. */
export function Screen({
  children,
  scroll = true,
  refreshControl,
  contentStyle,
  edges = ['top'],
}: {
  children: React.ReactNode;
  scroll?: boolean;
  refreshControl?: React.ReactElement;
  contentStyle?: StyleProp<ViewStyle>;
  edges?: Array<'top' | 'bottom' | 'left' | 'right'>;
}) {
  const inner = <View style={[styles.screenPad, contentStyle]}>{children}</View>;
  return (
    <SafeAreaView style={styles.screen} edges={edges}>
      {scroll ? (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          refreshControl={refreshControl}>
          {inner}
        </ScrollView>
      ) : (
        inner
      )}
    </SafeAreaView>
  );
}

/* -------------------------------------------------------------------- Text */

export function AppText({
  variant = 'body',
  style,
  children,
  numberOfLines,
}: {
  variant?: keyof typeof type;
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  numberOfLines?: number;
}) {
  return (
    <Text style={[type[variant], style]} numberOfLines={numberOfLines}>
      {children}
    </Text>
  );
}

/** Uppercase section label with a short teal tick. */
export function SectionLabel({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.sectionLabel, style]}>
      <View style={styles.sectionTick} />
      <Text style={type.eyebrow}>{children}</Text>
    </View>
  );
}

/* -------------------------------------------------------------------- Card */

export function Card({
  children,
  style,
  onPress,
  padded = true,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  padded?: boolean;
}) {
  const content = <View style={[styles.card, padded && styles.cardPad, style]}>{children}</View>;
  if (!onPress) return content;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => pressed && styles.pressed}>
      {content}
    </Pressable>
  );
}

/* ------------------------------------------------------------------ Button */

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  busyLabel,
  style,
  ...rest
}: {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  busyLabel?: string;
  style?: StyleProp<ViewStyle>;
} & Omit<PressableProps, 'style' | 'onPress'>) {
  const isDisabled = disabled || loading;
  const v = BTN[variant];
  return (
    <Pressable
      accessibilityRole="button"
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        v.container,
        pressed && !isDisabled && v.pressed,
        isDisabled && styles.btnDisabled,
        style,
      ]}
      {...rest}>
      {loading ? (
        <ActivityIndicator size="small" color={v.label.color as string} />
      ) : (
        <Text style={[type.button, v.label]}>{loading ? busyLabel ?? label : label}</Text>
      )}
    </Pressable>
  );
}

/* --------------------------------------------------------------------- Pill */

type Tone = 'teal' | 'coral' | 'amber' | 'sage' | 'neutral';

const PILL_TONE: Record<Tone, { bg: string; fg: string }> = {
  teal: { bg: colors.tealSoft, fg: colors.tealDeep },
  coral: { bg: colors.coralSoft, fg: '#9B2D18' },
  amber: { bg: colors.amberSoft, fg: '#8A6416' },
  sage: { bg: colors.sageSoft, fg: '#1E6B50' },
  neutral: { bg: colors.surfaceAlt, fg: colors.textMuted },
};

export function Pill({
  label,
  tone = 'neutral',
  bg,
  fg,
}: {
  label: string;
  tone?: Tone;
  bg?: string;
  fg?: string;
}) {
  const t = PILL_TONE[tone];
  return (
    <View style={[styles.pill, { backgroundColor: bg ?? t.bg }]}>
      <Text style={[styles.pillText, { color: fg ?? t.fg }]}>{label}</Text>
    </View>
  );
}

/* ---------------------------------------------------------------- PulseDot */

/** Small live-status dot. Solid = active, hollow = idle. */
export function PulseDot({ active }: { active: boolean }) {
  return (
    <View
      style={[
        styles.dot,
        active ? styles.dotActive : styles.dotIdle,
      ]}
    />
  );
}

/* ------------------------------------------------------------------- Meter */

/**
 * Signature element — the "calm meter": a rounded track with a filled portion
 * and optional segment ticks. Used for protection level, score, and progress.
 */
export function Meter({
  value,
  max = 100,
  tone = 'teal',
  height = 12,
  segments,
}: {
  value: number;
  max?: number;
  tone?: Tone;
  height?: number;
  segments?: number;
}) {
  const pct = Math.max(0, Math.min(1, max === 0 ? 0 : value / max));
  const fill = PILL_TONE[tone].fg;
  return (
    <View style={[styles.meterTrack, { height, borderRadius: height }]}>
      <View
        style={[
          styles.meterFill,
          { width: `${pct * 100}%`, backgroundColor: fill, borderRadius: height },
        ]}
      />
      {segments && segments > 1
        ? Array.from({ length: segments - 1 }).map((_, i) => (
            <View
              key={i}
              style={[styles.meterTick, { left: `${((i + 1) / segments) * 100}%` }]}
            />
          ))
        : null}
    </View>
  );
}

/* ---------------------------------------------------------------- StatTile */

export function StatTile({
  label,
  value,
  tone = 'neutral',
  hint,
}: {
  label: string;
  value: string | number;
  tone?: Tone;
  hint?: string;
}) {
  const t = PILL_TONE[tone];
  return (
    <View style={styles.statTile}>
      <Text style={[styles.statValue, { color: tone === 'neutral' ? colors.ink : t.fg }]}>
        {value}
      </Text>
      <Text style={type.eyebrow}>{label}</Text>
      {hint ? <Text style={[type.meta, { marginTop: 2 }]}>{hint}</Text> : null}
    </View>
  );
}

/* --------------------------------------------------------------- EmptyState */

export function EmptyState({
  icon = '🌱',
  title,
  message,
}: {
  icon?: string;
  title: string;
  message?: string;
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyIcon}>{icon}</Text>
      <Text style={[type.heading, { textAlign: 'center' }]}>{title}</Text>
      {message ? (
        <Text style={[type.body, { textAlign: 'center', marginTop: 4 }]}>{message}</Text>
      ) : null}
    </View>
  );
}

/* ----------------------------------------------------------------- Divider */

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.divider, style]} />;
}

/* ------------------------------------------------------------------ Loader */

export function Loader() {
  return (
    <View style={styles.loader}>
      <ActivityIndicator size="large" color={colors.teal} />
    </View>
  );
}

/* ------------------------------------------------------------------ styles */

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.sand },
  scrollContent: { flexGrow: 1 },
  screenPad: { padding: spacing.lg, gap: spacing.lg },

  sectionLabel: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sectionTick: { width: 14, height: 3, borderRadius: 2, backgroundColor: colors.teal },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    ...shadow.card,
  },
  cardPad: { padding: spacing.lg },
  pressed: { opacity: 0.85, transform: [{ scale: 0.995 }] },

  btn: {
    height: 50,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  btnDisabled: { opacity: 0.45 },

  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  pillText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.2 },

  dot: { width: 10, height: 10, borderRadius: 5 },
  dotActive: { backgroundColor: colors.sage },
  dotIdle: { backgroundColor: 'transparent', borderWidth: 2, borderColor: colors.textFaint },

  meterTrack: {
    width: '100%',
    backgroundColor: colors.sandDeep,
    overflow: 'hidden',
    position: 'relative',
  },
  meterFill: { height: '100%' },
  meterTick: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: colors.sand },

  statTile: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    gap: 2,
  },
  statValue: { fontSize: 26, fontWeight: '800', letterSpacing: -0.6 },

  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xxxl, gap: spacing.xs },
  emptyIcon: { fontSize: 40, marginBottom: spacing.sm },

  divider: { height: 1, backgroundColor: colors.line },

  loader: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.sand },
});

const BTN: Record<ButtonVariant, { container: ViewStyle; pressed: ViewStyle; label: TextStyle }> = {
  primary: {
    container: { backgroundColor: colors.teal },
    pressed: { backgroundColor: colors.tealDeep },
    label: { color: '#FFFFFF' },
  },
  secondary: {
    container: { backgroundColor: colors.tealSoft, borderWidth: 1, borderColor: colors.tealBorder },
    pressed: { backgroundColor: '#D3E7E0' },
    label: { color: colors.tealDeep },
  },
  danger: {
    container: { backgroundColor: colors.coralSoft, borderWidth: 1, borderColor: '#F3C7BB' },
    pressed: { backgroundColor: '#F8DBD1' },
    label: { color: '#9B2D18' },
  },
  ghost: {
    container: { backgroundColor: 'transparent' },
    pressed: { backgroundColor: colors.sandDeep },
    label: { color: colors.teal },
  },
};
