import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError, ErrorCode, logger } from '../utils';

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) {
  const reqId = req.id || 'unknown';

  // 1. Glox AppError
  if (err instanceof AppError || err.name === 'AppError' || (err.statusCode && err.code)) {
    if (err.statusCode >= 500) {
      req.log ? req.log.error(err) : logger.error({ err, reqId }, 'Server error');
    }
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        fields: err.fields,
        details: err.details,
      },
    });
  }

  // 2. Zod Validation Error
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
      const path = issue.path.join('.');
      fields[path || 'base'] = issue.message;
    }
    return res.status(400).json({
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Validation failed',
        fields,
      },
    });
  }

  // 3. Mongoose Validation Error
  if (err.name === 'ValidationError') {
    const fields: Record<string, string> = {};
    for (const key of Object.keys(err.errors || {})) {
      fields[key] = err.errors[key].message;
    }
    return res.status(400).json({
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: err.message,
        fields,
      },
    });
  }

  // 4. Mongoose Duplicate Key Error
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || 'resource';
    return res.status(409).json({
      error: {
        code: ErrorCode.ALREADY_EXISTS,
        message: `A record with this ${field} already exists`,
        details: { keyPattern: err.keyPattern },
      },
    });
  }

  // 5. Mongoose Cast Error & BSON Error (Invalid ObjectId)
  if (
    err.name === 'CastError' ||
    err.name === 'BSONError' ||
    err.name === 'BSONTypeError' ||
    (typeof err.message === 'string' && err.message.includes('BSON'))
  ) {
    return res.status(400).json({
      error: {
        code: ErrorCode.BAD_REQUEST,
        message: err.message || 'Invalid ID format',
      },
    });
  }

  // 6. JSON Syntax Error
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({
      error: {
        code: ErrorCode.BAD_REQUEST,
        message: 'Invalid JSON payload in request body',
      },
    });
  }

  // 7. Payload Too Large (1MB limit exceeded)
  if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
    return res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request entity too large (max 1MB)',
      },
    });
  }

  // 7. Unhandled Server Error
  req.log ? req.log.error(err) : logger.error({ err, reqId }, 'Unhandled server error');
  return res.status(500).json({
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected internal error occurred',
    },
  });
}
