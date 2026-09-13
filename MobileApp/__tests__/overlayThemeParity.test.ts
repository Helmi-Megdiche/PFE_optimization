import * as fs from 'fs';
import * as path from 'path';
import {focus, spacing, radius} from '../src/theme';

/**
 * ALL_IS_FIXED #54: the overlay's Android resource files (colors.xml / dimens.xml) are meant
 * to mirror theme/index.ts's `focus` design-system tokens -- reading them from disk and
 * asserting equality is the guard that keeps the two hand-maintained files in sync (#50's shape
 * for the third time in this chapter, per the brief). Per the addendum (G2): type sizes are
 * deliberately NOT asserted here -- neither MissionScreen.tsx nor QuizScreen.tsx actually
 * consumes theme/index.ts's `type` scale, so an overlay-equals-`type.*` assertion would lock in
 * a divergence from what the app really renders. Type-size choices and their real-app evidence
 * live in the #54 closeout instead. This test covers colors, spacing and radius only -- the
 * tokens the app genuinely consumes.
 */

function parseXmlValues(
  filePath: string,
  tag: 'color' | 'dimen',
): Record<string, string> {
  const xml = fs.readFileSync(filePath, 'utf8');
  const re = new RegExp(`<${tag} name="([^"]+)">([^<]+)</${tag}>`, 'g');
  const out: Record<string, string> = {};
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

const colorsXmlPath = path.join(
  __dirname,
  '../android/app/src/main/res/values/colors.xml',
);
const dimensXmlPath = path.join(
  __dirname,
  '../android/app/src/main/res/values/dimens.xml',
);

const overlayColors = parseXmlValues(colorsXmlPath, 'color');
const overlayDimens = parseXmlValues(dimensXmlPath, 'dimen');

// colors.xml name -> theme value it must equal. Most are `focus.*` lookups; `overlay_btn_text`
// is a literal because MissionScreen.primaryBtnText really does use a raw '#FFFFFF', not
// focus.text's warm white (see the #54 closeout).
const COLOR_MAP: Record<string, string> = {
  overlay_bg: focus.bg,
  overlay_option_bg: focus.surface,
  overlay_border: focus.border,
  overlay_title: focus.text,
  overlay_description: focus.textMuted,
  overlay_caption: focus.textMuted,
  overlay_badge: focus.amber,
  overlay_option_correct: focus.accentStrong,
  overlay_option_incorrect: focus.coral,
  overlay_warning: focus.coral,
  overlay_dot_active: focus.accent,
  overlay_dot_inactive: focus.border,
  overlay_btn_complete_bg: focus.accentStrong,
  overlay_btn_text: '#FFFFFF',
};

// dimens.xml name -> theme spacing/radius value it must equal (numeric, dp/sp stripped).
// overlay_spacing_xl intentionally maps to spacing.xxl, not spacing.xl -- the overlay's own
// "xl" name is 24dp, which is the app's xxl value; see the #54 closeout for the name-collision
// note. This is a value match, not a name match.
const SPACING_RADIUS_MAP: Record<string, number> = {
  overlay_spacing_xs: spacing.xs,
  overlay_spacing_sm: spacing.sm,
  overlay_spacing_md: spacing.md,
  overlay_spacing_lg: spacing.lg,
  overlay_spacing_xl: spacing.xxl,
  overlay_card_padding: spacing.xxl,
  overlay_radius_option: radius.md,
};

// Every dimens.xml name NOT in SPACING_RADIUS_MAP must be listed here, with a reason, or the
// fail-loud guard below breaks. Adding a new spacing/radius-shaped dimen with no counterpart
// must fail this test rather than pass silently.
const UNMAPPED_BY_DESIGN: Record<string, string> = {
  // Type sizes: pinned to MissionScreen.tsx/QuizScreen.tsx's real rendered values, not to
  // theme/index.ts's `type` scale (neither screen actually consumes `type.*`) -- see the #54
  // closeout for the per-role evidence table.
  overlay_text_badge: 'type size, pinned to real app renders, see closeout',
  overlay_text_title: 'type size, pinned to real app renders, see closeout',
  overlay_text_active_title: 'type size, constructed value, see closeout',
  overlay_text_description:
    'type size, pinned to real app renders, see closeout',
  overlay_text_caption: 'type size, pinned to real app renders, see closeout',
  overlay_text_warning: 'type size, pinned to real app renders, see closeout',
  overlay_text_question: 'type size, pinned to real app renders, see closeout',
  overlay_text_option: 'type size, pinned to real app renders, see closeout',
  overlay_text_progress_count:
    'type size, pinned to real app renders, see closeout',
  overlay_text_button: 'type size, pinned to real app renders, see closeout',
  // Layout constant, not a design token.
  overlay_content_max_width: 'device-width policy constant, not a design token',
  // Bespoke micro-decoration with no spacing-scale analog.
  overlay_dot_size: 'bespoke decorative micro-dimension, no spacing analog',
  overlay_dot_active_size:
    'bespoke decorative micro-dimension, no spacing analog',
  overlay_dot_gap: 'bespoke decorative micro-dimension, no spacing analog',
};

function normalizeHex(hex: string): string {
  return hex.trim().toUpperCase();
}

function parseDimenNumber(value: string): number {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(sp|dp)$/);
  if (!match) {
    throw new Error(
      `overlayThemeParity: could not parse dimen value "${value}"`,
    );
  }
  return parseFloat(match[1]);
}

describe('overlay theme parity (ALL_IS_FIXED #54)', () => {
  it('every color.xml name is mapped or explicitly allow-listed (fail loud on a new one)', () => {
    const unmapped = Object.keys(overlayColors).filter(
      name => !(name in COLOR_MAP),
    );
    expect(unmapped).toEqual([]);
  });

  it.each(Object.entries(COLOR_MAP))(
    '%s equals its theme counterpart',
    (name, expectedHex) => {
      expect(overlayColors[name]).toBeDefined();
      expect(normalizeHex(overlayColors[name])).toBe(normalizeHex(expectedHex));
    },
  );

  it('every dimens.xml name is a mapped spacing/radius value or explicitly allow-listed', () => {
    const unaccountedFor = Object.keys(overlayDimens).filter(
      name => !(name in SPACING_RADIUS_MAP) && !(name in UNMAPPED_BY_DESIGN),
    );
    expect(unaccountedFor).toEqual([]);
  });

  it.each(Object.entries(SPACING_RADIUS_MAP))(
    '%s equals its theme spacing/radius counterpart',
    (name, expectedValue) => {
      expect(overlayDimens[name]).toBeDefined();
      expect(parseDimenNumber(overlayDimens[name])).toBe(expectedValue);
    },
  );
});
