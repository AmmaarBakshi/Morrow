/** An error returned by the Morrow API, with the server's code and field details. */
export class MorrowApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string | null) {
    super(message);
    this.name = 'MorrowApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId ?? null;
  }

  /** Field-level problems for validation errors (422). */
  get issues(): Array<{ path: string; message: string }> {
    const d = this.details as { issues?: Array<{ path: string; message: string }> } | undefined;
    return d?.issues ?? [];
  }

  get retryAfterSeconds(): number | null {
    const d = this.details as { retryAfterSeconds?: number } | undefined;
    return d?.retryAfterSeconds ?? null;
  }
}

/** The request never produced an HTTP response (DNS, refused connection, timeout). */
export class MorrowNetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'MorrowNetworkError';
  }
}
