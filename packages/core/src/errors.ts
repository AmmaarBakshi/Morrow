/**
 * Typed application errors. Services throw these; transports (HTTP, CLI)
 * translate them into status codes and messages without leaking internals.
 */

export type ErrorCode =
  | 'bad_request'
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'precondition_failed'
  | 'rate_limited'
  | 'payload_too_large'
  | 'unavailable'
  | 'internal_error';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_error: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  rate_limited: 429,
  payload_too_large: 413,
  unavailable: 503,
  internal_error: 500,
};

export interface FieldIssue {
  path: string;
  message: string;
}

export class MorrowError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** Safe to show to end users. Internal errors always use a generic message. */
  readonly expose: boolean;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'MorrowError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
    this.expose = code !== 'internal_error';
  }
}

export class ValidationError extends MorrowError {
  readonly issues: FieldIssue[];
  constructor(message: string, issues: FieldIssue[] = []) {
    super('validation_error', message, { issues });
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export class NotFoundError extends MorrowError {
  constructor(entity: string, id?: string) {
    super('not_found', id ? `${entity} ${id} was not found.` : `${entity} was not found.`);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends MorrowError {
  constructor(message = 'You do not have permission to perform this action.') {
    super('forbidden', message);
    this.name = 'ForbiddenError';
  }
}

export class UnauthorizedError extends MorrowError {
  constructor(message = 'Authentication is required.') {
    super('unauthorized', message);
    this.name = 'UnauthorizedError';
  }
}

export class ConflictError extends MorrowError {
  constructor(message: string, details?: unknown) {
    super('conflict', message, details);
    this.name = 'ConflictError';
  }
}

export class PreconditionError extends MorrowError {
  constructor(message: string, details?: unknown) {
    super('precondition_failed', message, details);
    this.name = 'PreconditionError';
  }
}

export function isMorrowError(err: unknown): err is MorrowError {
  return err instanceof MorrowError;
}

/** Convert a zod-style issue list into {@link FieldIssue}s. */
export function toFieldIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): FieldIssue[] {
  return issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}
