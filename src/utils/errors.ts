/**
 * Standard error codes and AppError class per Glox Salon Backend SRS v1.0 section 11.
 */

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SESSION_REVOKED: 'SESSION_REVOKED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  RESOURCE_NOT_FOUND: 'NOT_FOUND',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  CONFLICT: 'CONFLICT',
  DUPLICATE_PHONE: 'DUPLICATE_PHONE',
  DUPLICATE_EMAIL: 'DUPLICATE_EMAIL',
  SLOT_CLASH: 'SLOT_CLASH',
  DAY_CLOSED: 'DAY_CLOSED',
  PAYROLL_STALE: 'PAYROLL_STALE',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  INVALID_STATE_TRANSITION: 'INVALID_TRANSITION',
  DISCOUNT_LIMIT: 'DISCOUNT_LIMIT',
  INSUFFICIENT_WALLET: 'INSUFFICIENT_WALLET',
  INSUFFICIENT_WALLET_BALANCE: 'INSUFFICIENT_WALLET',
  NO_SESSIONS_LEFT: 'NO_SESSIONS_LEFT',
  PLAN_INACTIVE: 'PLAN_INACTIVE',
  PLAN_OUT_OF_SCOPE: 'PLAN_OUT_OF_SCOPE',
  PLAN_IN_USE: 'PLAN_IN_USE',
  SPLIT_INVALID: 'SPLIT_INVALID',
  WINDOW_CLOSED: 'WINDOW_CLOSED',
  WA_WINDOW_CLOSED: 'WINDOW_CLOSED',
  WA_NOT_CONFIGURED: 'WA_NOT_CONFIGURED',
  WA_LOW_BALANCE: 'WA_LOW_BALANCE',
  BRANCH_INACTIVE: 'BRANCH_INACTIVE',
  SERVICE_INACTIVE_AT_BRANCH: 'SERVICE_INACTIVE_AT_BRANCH',
  BUSINESS_SUSPENDED: 'BUSINESS_SUSPENDED',
  RATE_LIMITED: 'RATE_LIMITED',
  TENANT_SCOPE_MISSING: 'TENANT_SCOPE_MISSING',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  BAD_REQUEST: 'VALIDATION_ERROR',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  USER_INACTIVE: 'ACCOUNT_INACTIVE',
  CROSS_BRANCH_FORBIDDEN: 'FORBIDDEN',
  PERMISSION_DENIED: 'FORBIDDEN',
  INTERNAL_ERROR: 'INTERNAL',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorResponsePayload {
  error: {
    code: ErrorCode;
    message: string;
    fields?: Record<string, string>;
    details?: any;
  };
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly fields?: Record<string, string>;
  public readonly details?: any;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    options?: { fields?: Record<string, string>; details?: any }
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
    this.statusCode = statusCode;
    this.code = code;
    this.fields = options?.fields;
    this.details = options?.details;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON(): ErrorResponsePayload {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.fields ? { fields: this.fields } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}
