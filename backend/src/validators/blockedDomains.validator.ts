import Joi from 'joi';

/**
 * Host-only charset: labels of `[a-z0-9-]`, dot-separated, no leading/trailing hyphen per
 * label, at least one dot. `.lowercase()` normalises case before this runs (Joi's default
 * `convert: true`), so the pattern itself only needs to reject what normalisation can't fix:
 * '/', '?', ' ', and a scheme prefix ('http://') all fall outside this charset already.
 */
const HOST_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const domainSchema = Joi.string()
  .max(253)
  .lowercase()
  .pattern(HOST_PATTERN)
  .message('domain must be a bare host — no scheme, path, query, or spaces');

export const recordBlockedDomainSchema = Joi.object({
  domain: domainSchema.required(),
  detectedAt: Joi.date().iso().required(),
});

export const listBlockedDomainsQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(200).default(100),
});

export const unblockDomainDevSchema = Joi.object({
  childId: Joi.string().uuid().required(),
  domain: domainSchema.required(),
});

export const recordBrowserIncidentSchema = Joi.object({
  domain: domainSchema.required(),
  listSource: Joi.string().valid('static', 'detected').required(),
  occurredAt: Joi.date().iso().required(),
});

export const listBrowserIncidentsQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(200).default(100),
});
