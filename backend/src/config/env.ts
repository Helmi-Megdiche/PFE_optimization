import dotenv from 'dotenv';

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Validates an IANA timezone name at boot, not per-query — a typo'd zone that silently
 * fell back to UTC would reproduce the ALL_IS_FIXED #10 defect while looking fixed.
 */
function validateTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`Invalid APP_TIMEZONE: "${tz}" is not a recognized IANA timezone name`);
  }
  return tz;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: requireEnv('DATABASE_URL'),
  jwtSecret: requireEnv('JWT_SECRET'),
  jwtIssuer: process.env.JWT_ISSUER ?? 'pfe-parental-control',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  isProduction: process.env.NODE_ENV === 'production',
  /** Legacy env name; cooldown is now “pending risky mission exists” (see hasRecentRiskyMission). */
  missionRiskCooldownMinutes: Number(
    process.env.MISSION_RISK_COOLDOWN_MINUTES ??
      (process.env.NODE_ENV === 'production' ? 15 : 2),
  ),
  /** ALL_IS_FIXED #10: named zone for day boundaries and the night-usage window. Optional,
   *  defaulted — never requireEnv (would deepen the clean-clone failure debt). */
  appTimezone: validateTimezone(process.env.APP_TIMEZONE ?? 'Africa/Tunis'),
} as const;
