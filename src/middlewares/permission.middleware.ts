import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCode } from '../utils';

export type UserPermissionFlag =
  | 'manageStaff'
  | 'approvePO'
  | 'viewPayroll'
  | 'editBranchPrices'
  | 'markAttendance';

export function requirePermission(flag: UserPermissionFlag) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.ctx) {
      return next(new AppError(401, ErrorCode.UNAUTHENTICATED, 'Authentication required'));
    }

    if (
      req.ctx.role === 'super_admin' ||
      req.ctx.role === 'owner' ||
      (req.ctx.role === 'manager' && flag === 'markAttendance')
    ) {
      return next();
    }

    const flags = req.ctx.flags || {};
    if (!flags[flag]) {
      return next(new AppError(403, ErrorCode.PERMISSION_DENIED, `Permission denied: missing ${flag} privilege`));
    }

    next();
  };
}
