export interface JwtPayloadClient {
  sub?: string;
  role?: string;
  childId?: string;
  /** Unix seconds — present on backend-issued tokens. */
  exp?: number;
}

export function decodeJwtPayload(token: string): JwtPayloadClient | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) {
      return null;
    }
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    if (typeof atob !== 'function') {
      return null;
    }
    const json = atob(padded);
    return JSON.parse(json) as JwtPayloadClient;
  } catch {
    return null;
  }
}

/** True when the JWT `exp` claim is in the past (missing `exp` → not expired). */
export function isJwtExpired(token: string, skewSeconds = 30): boolean {
  const payload = decodeJwtPayload(token);
  if (payload?.exp == null || !Number.isFinite(payload.exp)) {
    return false;
  }
  return payload.exp * 1000 <= Date.now() + skewSeconds * 1000;
}
