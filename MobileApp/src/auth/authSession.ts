/**
 * Lightweight bus so Profile logout / 401 handlers can force a fresh JWT
 * without sharing React state across App and Profile.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export function subscribeAuthSessionRefresh(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Ask App's useDevChildToken to clear/re-fetch the JWT. */
export function requestAuthSessionRefresh(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // ignore listener errors
    }
  }
}
