import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { AuthService } from '../services';
import { Business, Branch } from '../models';
import { env } from '../config';
import { AppError, ErrorCode } from '../utils';
import type { RequestContext } from '../services/context';

function getRefreshCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    path: '/auth',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}

function extractCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

/**
 * Read-only business rules every salon role needs (managers and branch logins cannot read
 * /business/settings). discountLimitBps is the effective cap billing applies to this user.
 */
function buildSessionConfig(ctx: RequestContext, b: any) {
  const limits = b.discountLimits ?? {};
  let discountLimitBps = 10000;
  if (ctx.role === 'manager') discountLimitBps = ctx.flags?.maxDiscountBps ?? limits.managerBps ?? 2000;
  else if (ctx.role === 'branch') discountLimitBps = limits.branchBps ?? 1000;
  return {
    gst: { enabled: b.gst?.enabled ?? false, rateBps: b.gst?.rateBps ?? 1800, pricesInclusive: b.gst?.pricesInclusive ?? false },
    fyStartMonth: b.fyStartMonth ?? 4,
    discountLimitBps,
    loyalty: {
      enabled: b.loyalty?.enabled ?? false,
      earnPer100: b.loyalty?.earnPer100 ?? 0,
      redeemValuePaise: b.loyalty?.redeemValuePaise ?? 0,
      minRedeem: b.loyalty?.minRedeem ?? 0,
      expiryDays: b.loyalty?.expiryDays ?? 0,
    },
    payroll: { pf: b.payroll?.pf?.enabled ?? false, esi: b.payroll?.esi?.enabled ?? false, pt: b.payroll?.pt?.enabled ?? false },
  };
}

export class AuthController {
  private authService: AuthService;

  constructor() {
    this.authService = new AuthService();
  }

  public login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.authService.login(req.body.email, req.body.password);
      res.cookie('refreshToken', result.refreshToken, getRefreshCookieOptions());
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public refresh = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = req.body?.refreshToken || extractCookie(req.headers.cookie, 'refreshToken');
      if (!token) {
        throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Refresh token is required');
      }
      const result = await this.authService.rotateRefreshToken(token);
      res.cookie('refreshToken', result.refreshToken, getRefreshCookieOptions());
      res.json({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        newRefreshToken: result.refreshToken,
      });
    } catch (err) {
      next(err);
    }
  };

  public logout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const refreshToken = req.body?.refreshToken || extractCookie(req.headers.cookie, 'refreshToken');
      if (refreshToken) {
        await this.authService.logout(refreshToken);
      }
      const { maxAge: _maxAge, ...clearOpts } = getRefreshCookieOptions();
      res.clearCookie('refreshToken', clearOpts);
      res.json({ success: true, message: 'Logged out successfully' });
    } catch (err) {
      next(err);
    }
  };

  public me = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Salon users also get their business and the branches they can open (owner: all)
      let business: any = null;
      let branches: unknown[] = [];
      let config: unknown = null;
      if (req.ctx.kind === 'tenant' && req.ctx.businessId) {
        const businessId = new Types.ObjectId(req.ctx.businessId);
        const branchQuery: Record<string, unknown> = { businessId };
        if (req.ctx.role !== 'owner') {
          branchQuery._id = { $in: req.ctx.branchIds.map((id) => new Types.ObjectId(id)) };
        }
        let settings: any;
        [settings, branches] = await Promise.all([
          Business.findById(businessId).select('name logoUrl status headBranchId gst fyStartMonth discountLimits loyalty payroll').lean(),
          Branch.find(branchQuery).select('name code status').sort({ createdAt: 1 }).lean(),
        ]);
        if (settings) {
          business = { _id: settings._id, name: settings.name, logoUrl: settings.logoUrl, status: settings.status, headBranchId: settings.headBranchId, gst: { enabled: settings.gst?.enabled ?? false } };
          config = buildSessionConfig(req.ctx, settings);
        }
      }

      res.json({
        business,
        branches,
        config,
        user: {
          id: req.ctx.userId,
          name: req.ctx.name,
          email: req.ctx.email,
          role: req.ctx.role,
          kind: req.ctx.kind,
          businessId: req.ctx.businessId,
          branchId: req.ctx.branchId,
          branchIds: req.ctx.branchIds,
          flags: req.ctx.flags,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}

export const authController = new AuthController();
