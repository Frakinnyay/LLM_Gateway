export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'rate_limit_error'
  | 'budget_exceeded_error'
  | 'provider_error'
  | 'service_unavailable_error'
  | 'internal_error';

/** Application error that is safe to serialise to clients. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: ErrorType,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface ErrorBody {
  error: { message: string; type: ErrorType; code: string; request_id?: string };
}

export function toErrorBody(err: AppError, requestId?: string): ErrorBody {
  return { error: { message: err.message, type: err.type, code: err.code, request_id: requestId } };
}
