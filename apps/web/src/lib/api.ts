import { MorrowApiError, MorrowClient } from '@morrow/sdk';

let csrfToken: string | null = null;

/** Called whenever the session is (re)loaded so writes carry the CSRF token. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/**
 * The web app talks to its own origin with the session cookie; the CSRF
 * token from the session is echoed on every write.
 */
export const api = new MorrowClient({
  baseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  credentials: 'same-origin',
  csrfToken: () => csrfToken,
});

export function isApiError(err: unknown, status?: number): err is MorrowApiError {
  return err instanceof MorrowApiError && (status === undefined || err.status === status);
}

/** A human message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof MorrowApiError) {
    const first = err.issues[0];
    return first && first.message !== err.message ? `${err.message} (${first.path}: ${first.message})` : err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
