import {ApiAuthError, ApiHttpError} from '../services/apiClient';

export type CompletionFailureAction = 'alreadyFinished' | 'recoverable';

export type CompletionFailureDecision = {
  action: CompletionFailureAction;
  title: string;
  message: string;
};

/**
 * Maps a mission-completion failure to what the child should see. Every message is a fixed,
 * curated string — never `err.message` — so the raw wire text (e.g. `HTTP 404: {"error":...}`)
 * never reaches the screen for any failure shape, not just the one the original bug report named.
 */
export function decideCompletionFailure(
  err: unknown,
): CompletionFailureDecision {
  if (err instanceof ApiHttpError) {
    switch (err.status) {
      case 409:
        return {
          action: 'alreadyFinished',
          title: 'Mission already finished',
          message:
            'This mission was already completed. You can close this screen.',
        };
      case 404:
        return {
          action: 'recoverable',
          title: 'Mission unavailable',
          message:
            'This mission is no longer available. You can retry or close this screen.',
        };
      case 410:
        return {
          action: 'recoverable',
          title: 'Mission expired',
          message:
            'This mission has expired. You can retry or close this screen.',
        };
      default:
        return {
          action: 'recoverable',
          title: 'Could not complete mission',
          message:
            'Something went wrong saving this mission. You can retry or close this screen.',
        };
    }
  }
  if (err instanceof ApiAuthError) {
    return {
      action: 'recoverable',
      title: 'Sign-in expired',
      message:
        'Your sign-in needs to be refreshed. You can retry or close this screen.',
    };
  }
  return {
    action: 'recoverable',
    title: 'Connection problem',
    message:
      'Could not reach the server to save this mission. You can retry or close this screen.',
  };
}
