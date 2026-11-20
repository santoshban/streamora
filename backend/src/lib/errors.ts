export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, 'BAD_REQUEST', details);
export const unauthorized = (message = 'Select a profile first') => new HttpError(401, message, 'UNAUTHORIZED');
export const forbidden = (message = 'Admin profile required') => new HttpError(403, message, 'FORBIDDEN');
export const notFound = (message = 'Not found') => new HttpError(404, message, 'NOT_FOUND');
export const conflict = (message: string) => new HttpError(409, message, 'CONFLICT');
export const tooManyRequests = (message: string) => new HttpError(429, message, 'TOO_MANY_REQUESTS');

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
