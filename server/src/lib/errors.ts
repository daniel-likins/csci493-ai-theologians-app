/**
 * Application error with a stable machine-readable code and an HTTP status.
 * Messages are written for the user: plain, specific, and actionable.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function notFound(what: string): AppError {
  return new AppError('not_found', `${what} not found.`, 404);
}

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError('bad_request', message, 400, details);
}

export function conflict(message: string, details?: unknown): AppError {
  return new AppError('conflict', message, 409, details);
}

export function forbidden(message: string, details?: unknown): AppError {
  return new AppError('forbidden', message, 403, details);
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
