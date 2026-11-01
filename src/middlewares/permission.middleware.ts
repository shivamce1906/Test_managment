import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCode } from '../utils';
import { RequestContext } from '../services/context';

export type UserPermissionFlag =
  | 'manageStaff'
  | 'approvePO'
  | 'viewPayroll'
  | 'editBranchPrices'
  | 'editBranch'
  | 'manageCatalogue'
  | 'manageCustomers'
  | 'manageFinance'
  | 'managePayroll'
  | 'exportAudit'
  | 'manageMarketing'
  | 'markAttendance';

/**
 * Service-level check: owners (and platform admins) always pass; managers need the flag; branch logins never pass.
 * Routes guard with requireRole + requirePermission; services repeat it so direct calls stay safe.
 */
export function hasPermission(ctx: RequestContext, flag: UserPermissionFlag): boolean {
  if (ctx.role === 'owner' || ctx.role === 'super_admin' || ctx.role === 'superadmin') return true;
  return ctx.role === 'manager' && Boolean(ctx.flags?.[flag]);
}

export function requirePermission(flag: UserPermissionFlag) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.ctx) {
      return next(new AppError(401, ErrorCode.UNAUTHENTICATED, 'Authentication required'));
    }

    if (req.ctx.role === 'super_admin' || req.ctx.role === 'owner') {
      return next();
    }

    const flags = req.ctx.flags || {};
    if (!flags[flag]) {
      return next(new AppError(403, ErrorCode.PERMISSION_DENIED, `Permission denied: missing ${flag} privilege`));
    }

    next();
  };
}

/**
 * Like requirePermission, but only branch logins need the flag (owners and managers always pass).
 * Used for markAttendance: managers mark attendance by default; a front desk needs it switched on.
 */
export function requireBranchLoginPermission(flag: UserPermissionFlag) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.ctx) {
      return next(new AppError(401, ErrorCode.UNAUTHENTICATED, 'Authentication required'));
    }
    if (req.ctx.role === 'branch' && !req.ctx.flags?.[flag]) {
      return next(new AppError(403, ErrorCode.PERMISSION_DENIED, `Permission denied: missing ${flag} privilege`));
    }
    next();
  };
}
