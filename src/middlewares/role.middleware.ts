import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCode } from '../utils';

export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.ctx) {
      return next(new AppError(401, ErrorCode.UNAUTHENTICATED, 'Authentication required'));
    }

    const normalizedAllowed = allowedRoles.flatMap((r) =>
      r === 'super_admin' || r === 'superadmin' ? ['super_admin', 'superadmin'] : [r]
    );
    if (!normalizedAllowed.includes(req.ctx.role)) {
      return next(new AppError(403, ErrorCode.FORBIDDEN, `Access denied for role: ${req.ctx.role}`));
    }

    next();
  };
}

export function requireKind(kind: 'platform' | 'tenant') {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.ctx) {
      return next(new AppError(401, ErrorCode.UNAUTHENTICATED, 'Authentication required'));
    }

    if (req.ctx.kind !== kind) {
      return next(new AppError(403, ErrorCode.FORBIDDEN, `Access denied: requires ${kind} credentials`));
    }

    next();
  };
}
