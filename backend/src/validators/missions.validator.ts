import Joi from 'joi';
import { MISSION_TEMPLATES } from '../services/missionGenerator';

export const suggestMissionSchema = Joi.object({
  category: Joi.string().max(50).required(),
  textSnippet: Joi.string().max(500).allow('').default(''),
});

export const completeMissionSchema = Joi.object({
  exerciseScore: Joi.number().min(0).max(100).optional(),
  reactionTimeMs: Joi.number().integer().min(0).optional(),
  moves: Joi.number().integer().min(1).optional(),
  answers: Joi.array().items(Joi.string().max(10)).optional(),
  won: Joi.boolean().optional(),
  completed: Joi.boolean().optional(),
  confirmed: Joi.boolean().optional(),
  // Tic-Tac-Toe evidence (ALL_IS_FIXED #51). Both stay .optional() here — this schema is
  // shared flat across every mission type with no .when() conditionals — the actual
  // enforcement (required + replayed + verified) lives in evaluateMissionCompletion's
  // minigame/tictactoe branch, not in Joi. Distinct field names from `moves` (Hanoi's
  // numeric move count) — same schema, different key, no collision.
  //
  // Joi.valid(...) deliberately, not Joi.string().valid(...): Joi.string() rejects '' by
  // default, which would 400 every board containing an empty cell — i.e. most wins (a win
  // normally leaves cells empty; only a draw fills the board).
  finalBoard: Joi.array().items(Joi.valid('X', 'O', '')).length(9).optional(),
  moveSequence: Joi.array().items(Joi.number().integer().min(0).max(8)).optional(),
});

export const generateMissionDevSchema = Joi.object({
  childId: Joi.string().uuid().required(),
  triggerType: Joi.string()
    .valid('risky_content', 'low_wellbeing', 'high_addiction', 'cognitive_boost')
    .required(),
  score: Joi.number().min(0).max(100).required(),
  category: Joi.string().max(50).optional(),
});

/**
 * POST /api/missions/dev/force (dev-only). `templateKey` is a `.valid()` enum
 * derived from MISSION_TEMPLATES, so an unknown key is a 400 that names the
 * valid keys; `triggerReason` / `score` default here (validateBody writes the
 * validated value back to req.body, so the defaults reach the handler).
 */
export const forceMissionDevSchema = Joi.object({
  childId: Joi.string().uuid().required(),
  templateKey: Joi.string()
    .valid(...Object.keys(MISSION_TEMPLATES))
    .required(),
  triggerReason: Joi.string()
    .valid('risky_content', 'low_wellbeing', 'high_addiction', 'cognitive_boost')
    .default('risky_content'),
  category: Joi.string().max(50).optional(),
  score: Joi.number().min(0).max(100).default(75),
});
