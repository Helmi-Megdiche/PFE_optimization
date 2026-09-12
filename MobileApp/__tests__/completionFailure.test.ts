import {decideCompletionFailure} from '../src/missions/completionFailure';
import {ApiAuthError, ApiHttpError} from '../src/services/apiClient';

// The 6 distinct curated strings the real implementation returns. The regression guard (case 9)
// asserts every case's message is one of these — not just that it lacks the substring 'HTTP' —
// so a future branch that reintroduces raw err.message text fails loudly even if that raw text
// happens not to contain 'HTTP'.
const MSG_ALREADY_FINISHED =
  'This mission was already completed. You can close this screen.';
const MSG_UNAVAILABLE =
  'This mission is no longer available. You can retry or close this screen.';
const MSG_EXPIRED =
  'This mission has expired. You can retry or close this screen.';
const MSG_GENERIC =
  'Something went wrong saving this mission. You can retry or close this screen.';
const MSG_AUTH_EXPIRED =
  'Your sign-in needs to be refreshed. You can retry or close this screen.';
const MSG_CONNECTION =
  'Could not reach the server to save this mission. You can retry or close this screen.';

const KNOWN_MESSAGES = [
  MSG_ALREADY_FINISHED,
  MSG_UNAVAILABLE,
  MSG_EXPIRED,
  MSG_GENERIC,
  MSG_AUTH_EXPIRED,
  MSG_CONNECTION,
];

describe('decideCompletionFailure', () => {
  it('case 1: 409 -> alreadyFinished, exact title/message', () => {
    const err = new ApiHttpError(
      409,
      'HTTP 409: {"error":"Mission already completed or awaiting approval"}',
    );
    expect(decideCompletionFailure(err)).toEqual({
      action: 'alreadyFinished',
      title: 'Mission already finished',
      message: MSG_ALREADY_FINISHED,
    });
  });

  it('case 2: 404 -> recoverable, exact title/message', () => {
    const err = new ApiHttpError(
      404,
      'HTTP 404: {"error":"Mission not found"}',
    );
    expect(decideCompletionFailure(err)).toEqual({
      action: 'recoverable',
      title: 'Mission unavailable',
      message: MSG_UNAVAILABLE,
    });
  });

  it('case 3: 410 -> recoverable, exact title/message (distinct from 400/500)', () => {
    const err = new ApiHttpError(410, 'HTTP 410: {"error":"Mission expired"}');
    expect(decideCompletionFailure(err)).toEqual({
      action: 'recoverable',
      title: 'Mission expired',
      message: MSG_EXPIRED,
    });
  });

  it('case 4: 400 -> recoverable, generic title/message', () => {
    const err = new ApiHttpError(
      400,
      'HTTP 400: {"error":"Mission cannot be completed in current state"}',
    );
    expect(decideCompletionFailure(err)).toEqual({
      action: 'recoverable',
      title: 'Could not complete mission',
      message: MSG_GENERIC,
    });
  });

  it('case 5: 500 -> recoverable, same generic text as 400 (shared default branch)', () => {
    const err = new ApiHttpError(
      500,
      'HTTP 500: {"error":"Failed to complete mission"}',
    );
    expect(decideCompletionFailure(err)).toEqual({
      action: 'recoverable',
      title: 'Could not complete mission',
      message: MSG_GENERIC,
    });
  });

  it('case 6: ApiAuthError (401) -> recoverable, honest sign-in message', () => {
    const err = new ApiAuthError('Session expired or invalid token');
    expect(decideCompletionFailure(err)).toEqual({
      action: 'recoverable',
      title: 'Sign-in expired',
      message: MSG_AUTH_EXPIRED,
    });
  });

  it('case 7: plain network TypeError -> recoverable, connection-problem text', () => {
    const err = new TypeError('Network request failed');
    expect(decideCompletionFailure(err)).toEqual({
      action: 'recoverable',
      title: 'Connection problem',
      message: MSG_CONNECTION,
    });
  });

  it('case 8: non-Error throw -> recoverable, same fallback text as case 7', () => {
    const err = 'boom';
    expect(decideCompletionFailure(err)).toEqual({
      action: 'recoverable',
      title: 'Connection problem',
      message: MSG_CONNECTION,
    });
  });

  it('case 9 (guard): every case above returns a message from the known allow-list', () => {
    const inputs: unknown[] = [
      new ApiHttpError(409, 'HTTP 409: ...'),
      new ApiHttpError(404, 'HTTP 404: ...'),
      new ApiHttpError(410, 'HTTP 410: ...'),
      new ApiHttpError(400, 'HTTP 400: ...'),
      new ApiHttpError(500, 'HTTP 500: ...'),
      new ApiAuthError('Session expired or invalid token'),
      new TypeError('Network request failed'),
      'boom',
    ];
    for (const err of inputs) {
      const {message} = decideCompletionFailure(err);
      expect(KNOWN_MESSAGES).toContain(message);
    }
  });
});
