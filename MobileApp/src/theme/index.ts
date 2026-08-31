/**
 * SafeGuard design system — "Calm Guardian".
 *
 * One source of truth for color, type, spacing, radius and elevation.
 * Trust-first palette: warm sand ground, deep-teal ink, coral only for alerts.
 * Import tokens from here; never hardcode hex in screens.
 */
import { Platform, TextStyle, ViewStyle } from 'react-native';

export const colors = {
  // Ground & surfaces (warm, calm)
  sand: '#F4EFE6', // app background
  sandDeep: '#ECE4D6', // pressed / inset surfaces
  surface: '#FFFDFA', // cards
  surfaceAlt: '#F7F2E9', // subtle inset panels

  // Brand teal
  ink: '#14302E', // primary text, wordmark
  teal: '#1F6F63', // primary action / brand accent
  tealDeep: '#16564C', // pressed primary
  tealSoft: '#E1EFEA', // teal tint background
  tealBorder: '#BFDBD2',

  // Accents
  coral: '#E8654A', // alerts / danger
  coralSoft: '#FCE9E3',
  amber: '#D9992F', // warnings
  amberSoft: '#F7ECD5',
  sage: '#2E9E7B', // success / positive
  sageSoft: '#DFF1EA',

  // Text
  textMuted: '#5F6F6B', // secondary text
  textFaint: '#93A09B', // tertiary / meta

  // Lines
  line: '#E7DFD1', // warm hairline
  lineStrong: '#D8CDB9',
} as const;

/** Risk/content category → tint + text color (mirrors backend categories). */
export const categoryTone: Record<string, { bg: string; fg: string }> = {
  adult: { bg: colors.coralSoft, fg: '#9B2D18' },
  violent: { bg: '#F7E4D6', fg: '#8A3B18' },
  gore: { bg: '#F8E1EA', fg: '#8A1F45' },
  dangerous: { bg: colors.amberSoft, fg: '#8A6416' },
  dangerous_challenge: { bg: colors.amberSoft, fg: '#8A6416' },
  educational: { bg: colors.tealSoft, fg: colors.tealDeep },
  neutral: { bg: colors.surfaceAlt, fg: colors.textMuted },
};

export function toneForCategory(category?: string | null) {
  if (!category) return categoryTone.neutral;
  return categoryTone[category] ?? categoryTone.neutral;
}

/**
 * "Focus mode" — the dark, immersive surface used for active missions, games
 * and quizzes. Same Calm Guardian family, inverted for concentration.
 */
export const focus = {
  bg: '#122926', // deep ink-teal ground
  surface: '#1C3A35', // raised cards / tiles
  surfaceAlt: '#244A44', // alt cells
  border: '#2E5C54',
  text: '#F4EFE6', // warm white
  textMuted: '#93B0A9',
  accent: '#5FD3BE', // highlights, letters, marks
  accentStrong: '#2E9E7B', // primary buttons / "go"
  accentPressed: '#25806340',
  coral: '#F07A5F', // errors / quit / opponent
  amber: '#E7B85C', // eyebrow / status
  disks: ['#5FD3BE', '#E7B85C', '#7FB2F0', '#EFA0C0'],
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const radius = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

const fontFamily = Platform.select({ android: 'sans-serif', default: 'System' });
const fontFamilyMedium = Platform.select({ android: 'sans-serif-medium', default: 'System' });

/** Type scale — system face, personality from weight + tracking. */
export const type: Record<string, TextStyle> = {
  // Big hero numeral (scores, points)
  display: { fontFamily, fontSize: 44, fontWeight: '800', color: colors.ink, letterSpacing: -1 },
  title: { fontFamily, fontSize: 24, fontWeight: '800', color: colors.ink, letterSpacing: -0.4 },
  heading: { fontFamily, fontSize: 18, fontWeight: '700', color: colors.ink, letterSpacing: -0.2 },
  cardTitle: { fontFamily: fontFamilyMedium, fontSize: 16, fontWeight: '700', color: colors.ink },
  body: { fontFamily, fontSize: 14, fontWeight: '400', color: colors.textMuted, lineHeight: 21 },
  bodyStrong: { fontFamily: fontFamilyMedium, fontSize: 14, fontWeight: '600', color: colors.ink },
  meta: { fontFamily, fontSize: 12.5, fontWeight: '400', color: colors.textFaint, lineHeight: 18 },
  // Uppercase eyebrow / section label
  eyebrow: {
    fontFamily: fontFamilyMedium,
    fontSize: 11.5,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  button: { fontFamily: fontFamilyMedium, fontSize: 15, fontWeight: '700', letterSpacing: 0.2 },
};

/** Soft, warm elevation. Android uses elevation; iOS uses shadow*. */
export const shadow = {
  card: {
    shadowColor: '#3A2E1A',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  } as ViewStyle,
  raised: {
    shadowColor: '#3A2E1A',
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 5,
  } as ViewStyle,
};

export const theme = { colors, spacing, radius, type, shadow, toneForCategory };
export type Theme = typeof theme;
