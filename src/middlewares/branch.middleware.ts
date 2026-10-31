import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { Branch } from '../models';
import { AppError, ErrorCode } from '../utils';

export async function requireBranchAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.ctx) {
    return next(new AppError(401, ErrorCode.UNAUTHENTICATED, 'Authentication required'));
  }

  const branchId = req.params.branchId || (req.query.branchId as string) || (req.body && req.body.branchId);
  if (!branchId) {
    return next(new AppError(400, ErrorCode.BAD_REQUEST, 'branchId is required'));
  }
  if (!Types.ObjectId.isValid(branchId)) {
    return next(new AppError(400, ErrorCode.BAD_REQUEST, 'Invalid branchId'));
  }

  // Owner has access to every branch of their own business (another business's branch is a 404)
  if (req.ctx.role === 'owner') {
    try {
      const exists = await Branch.exists({ _id: new Types.ObjectId(branchId), businessId: new Types.ObjectId(req.ctx.businessId) });
      if (!exists) {
        return next(new AppError(404, ErrorCode.NOT_FOUND, 'Branch not found'));
      }
    } catch (err) {
      return next(err);
    }
    req.ctx.branchId = branchId;
    return next();
  }

  if (req.ctx.role === 'super_admin') {
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
