import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCode } from '../utils';

export function requireBranchAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.ctx) {
    return next(new AppError(401, ErrorCode.UNAUTHENTICATED, 'Authentication required'));
  }

  const branchId = req.params.branchId || (req.query.branchId as string) || (req.body && req.body.branchId);
  if (!branchId) {
    return next(new AppError(400, ErrorCode.BAD_REQUEST, 'branchId is required'));
  }

  // Super Admin and Owner have access to all branches of their tenant
  if (req.ctx.role === 'super_admin' || req.ctx.role === 'owner') {
    req.ctx.branchId = branchId;
    return next();
  }

  // Branch login is strictly bound to its assigned branch(es)
  if (req.ctx.role === 'branch') {
    const isAllowed = req.ctx.branchId === branchId || req.ctx.branchIds.includes(branchId);
    if (!isAllowed) {
      return next(new AppError(403, ErrorCode.CROSS_BRANCH_FORBIDDEN, 'Branch login cannot access other branches'));
    }
    req.ctx.branchId = branchId;
    return next();
  }

  // Manager is scoped to assigned branchIds
  if (req.ctx.role === 'manager') {
    if (!req.ctx.branchIds.includes(branchId)) {
      return next(new AppError(403, ErrorCode.CROSS_BRANCH_FORBIDDEN, 'Manager is not assigned to this branch'));
    }
    req.ctx.branchId = branchId;
    return next();
  }

  next(new AppError(403, ErrorCode.FORBIDDEN, 'Access denied to branch'));
}
