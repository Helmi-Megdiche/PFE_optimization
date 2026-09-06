import Joi from 'joi';
import { logger } from '../utils/logger';

/**
 * Wire-payload privacy contract for POST /api/screen-events.
 *
 * The privacy invariant (CLAUDE.md): the device sends only text metadata — never a screenshot.
 * `extractedTextPreview` is the primary privacy field and is REJECT-on-overflow (see below).
 * `imageClassificationDetails` used to be a keyless `Joi.object()`, i.e. up to ~32 KB of
 * arbitrary client JSON straight into a JSONB column that is echoed to the parent dashboard.
 * It is now an enumerable schema: a fixed set of named fields, every string length-capped,
 * unknown keys stripped by the global `stripUnknown: true` (see middleware/validate.ts) and
 * logged once by `warnOnStrippedDetailKeys`.
 */

/** Every key the on-device producer (MobileApp `ImageClassificationDetails`) may legitimately set. */
export const KNOWN_IMAGE_DETAIL_KEYS: ReadonlySet<string> = new Set([
  'source',
  'violenceScore',
  'adultScore',
  'goreScore',
  'dangerousChallengeScore',
  'educationalScore',
  'imageRiskScore',
  'mappedCategory',
  'topRiskLabels',
  'categoryWeights',
  'mlKitLabels',
  'nsfwSource',
  'nsfwProbabilities',
  'tfliteOutputs',
  'captureQualityHint',
  'mockHint',
]);

const MAX_LOGGED_STRIPPED_KEYS = 5;
const STRIPPED_KEY_NAME_MAXLEN = 40;

/** A stripped key name is attacker-controlled: drop ASCII control chars, cap length, never log values. */
function sanitizeStrippedKeyName(key: string): string {
  let out = '';
  for (const ch of String(key)) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    out += ch;
    if (out.length >= STRIPPED_KEY_NAME_MAXLEN) {
      break;
    }
  }
  return out;
}

/**
 * Detection / logging ONLY — returns `value` unchanged. The keyed schema plus the global
 * `stripUnknown: true` perform the actual stripping; Joi exposes no "what was stripped" hook,
 * so this compares the pre-strip keys (`helpers.original`) against the DECLARED known set.
 *
 * Diffing against `value` instead would be wrong: `mockHint` is `.strip()`ped, so it is present
 * in `original` and absent from `value` on every mock-path capture — a false "unknown key".
 *
 * SCOPE: top level of `imageClassificationDetails` only. Keys stripped from inside
 * `categoryWeights` / `nsfwProbabilities` / `mlKitLabels` items are NOT reported here.
 */
function warnOnStrippedDetailKeys(value: unknown, helpers: Joi.CustomHelpers): unknown {
  const original = helpers.original;
  if (original && typeof original === 'object' && !Array.isArray(original)) {
    const unknown = Object.keys(original as Record<string, unknown>).filter(
      (k) => !KNOWN_IMAGE_DETAIL_KEYS.has(k),
    );
    if (unknown.length > 0) {
      logger.warn('screen-event imageClassificationDetails: stripped unknown keys', {
        strippedCount: unknown.length,
        strippedKeys: unknown.slice(0, MAX_LOGGED_STRIPPED_KEYS).map(sanitizeStrippedKeyName),
      });
    }
  }
  return value;
}

const scoreField = Joi.number().min(0).max(100);

/**
 * Enumerable schema for `imageClassificationDetails`. Rules:
 *  - string caps use `.truncate()` (clip, never 400) so a tightened cap can't kill a capture;
 *  - array / pattern-map COUNT caps are `.max(n)` (reject) with generous headroom over the
 *    producer's structural ceiling — a wrong-low count cap would 400 every capture;
 *  - `mockHint` is validated then `.strip()`ped: it is a device filesystem-path tail with no
 *    server-side consumer and no business in a column echoed to a parent dashboard.
 */
const imageClassificationDetailsSchema = Joi.object({
  source: Joi.string().valid('tflite', 'mlkit', 'mock'),
  violenceScore: scoreField,
  adultScore: scoreField,
  goreScore: scoreField,
  dangerousChallengeScore: scoreField,
  educationalScore: scoreField,
  imageRiskScore: scoreField,
  mappedCategory: Joi.string().max(40).truncate().allow(''),
  // producer ceiling: mapMlKitLabelsToRisk topLabels = labels.slice(0, 10); .max(15) = 10 + headroom
  topRiskLabels: Joi.array().items(Joi.string().max(40).truncate().allow('')).max(15),
  // producer: RiskMapCategory (6 values) + merged `adult` key; 16 = deliberate headroom
  categoryWeights: Joi.object().pattern(Joi.string().max(40), Joi.number()).max(16),
  // producer: labels.slice(0, 15); keyed item object so stripUnknown drops a 3rd key inside items
  mlKitLabels: Joi.array()
    .items(
      Joi.object({
        text: Joi.string().max(40).truncate().allow(''),
        confidence: Joi.number(),
      }),
    )
    .max(15),
  nsfwSource: Joi.string().max(40).truncate().allow(''),
  nsfwProbabilities: Joi.object().pattern(Joi.string().max(20), Joi.number()).max(10),
  tfliteOutputs: Joi.array().items(Joi.number()).max(16),
  captureQualityHint: Joi.string().valid('ok', 'blank_or_protected'),
  mockHint: Joi.string().max(64).optional().strip(),
})
  .optional()
  .allow(null)
  .custom(warnOnStrippedDetailKeys, 'warn-on-stripped-detail-keys');

export const createScreenEventSchema = Joi.object({
  timestamp: Joi.date().iso().required(),
  appPackage: Joi.string().max(255).required(),
  appLabel: Joi.string().max(255).optional().allow(null, ''),
  // Primary privacy field: REJECT on overflow, never truncate. The mobile side already
  // guarantees <=500 via truncateText(); a client bug here must be loud, not silently clipped.
  extractedTextPreview: Joi.string().max(500).allow('').default(''),
  riskFlag: Joi.boolean().required(),
  riskScore: Joi.number().min(0).max(100).optional().allow(null),
  imageRiskScore: Joi.number().integer().min(0).max(100).optional().allow(null),
  combinedRiskScore: Joi.number().integer().min(0).max(100).optional().allow(null),
  imageClassificationDetails: imageClassificationDetailsSchema,
  category: Joi.string()
    .valid(
      'violent',
      'toxic',
      'dangerous',
      'educational',
      'neutral',
      'adult',
      'gore',
      'dangerous_challenge',
    )
    .optional()
    .allow(null),
});

export const listScreenEventsQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(10),
});
