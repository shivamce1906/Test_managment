import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services';
import { PlatformAdmin, User, Business, Branch } from '../models';
import { AppError, ErrorCode } from '../utils';
import { RequestContext } from '../services';

const authService = new AuthService();

export function authenticate(options: { required?: boolean } = { required: true }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        if (options.required) {
          throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Authentication token missing or invalid');
        }
        return next();
      }

      const token = authHeader.substring(7);
      const decoded = await authService.verifyAccessToken(token);

      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '127.0.0.1';
      const userAgent = req.headers['user-agent'];

      if (decoded.kind === 'platform') {
        const admin = await PlatformAdmin.findById(decoded.sub);
        if (!admin || admin.status !== 'active') {
          throw new AppError(401, ErrorCode.USER_INACTIVE, 'Platform administrator account is inactive or not found');
        }
        if (decoded.sv !== admin.sessionVersion) {
          throw new AppError(401, ErrorCode.SESSION_REVOKED, 'Session has been revoked');
        }

        req.ctx = {
          userId: admin._id.toString(),
          role: 'super_admin',
          kind: 'platform',
          name: admin.name,
          email: admin.email,
          branchIds: [],
          ip,
          userAgent,
          reqId: req.id,
        };
      } else {
        const user = await User.findById(decoded.sub, null, { skipTenantScope: true });
        if (!user || user.status !== 'active') {
          throw new AppError(401, ErrorCode.USER_INACTIVE, 'User account is inactive or not found');
        }
        if (decoded.sv !== user.sessionVersion) {
          throw new AppError(401, ErrorCode.SESSION_REVOKED, 'Session has been revoked');
        }

        const business = await Business.findById(user.businessId).lean();
        if (!business || business.status === 'suspended') {
          throw new AppError(403, ErrorCode.ACCOUNT_INACTIVE, 'Business account is suspended or inactive');
        }

        if (user.role === 'branch' && user.branchLoginFor) {
          const branch = await Branch.findById(user.branchLoginFor, null, { skipTenantScope: true }).lean();
          if (!branch || branch.status === 'deactivated') {
            throw new AppError(403, ErrorCode.BRANCH_INACTIVE, 'Branch is deactivated');
          }
        }

        req.ctx = {
          userId: user._id.toString(),
          businessId: user.businessId.toString(),
          role: user.role,
          kind: 'tenant',
          name: user.name,
          email: user.email,
          branchId: user.branchLoginFor ? user.branchLoginFor.toString() : undefined,
          branchIds: (user.branchIds || []).map((b) => b.toString()),
          flags: user.flags,
          ip,
          userAgent,
          reqId: req.id,
        };
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
