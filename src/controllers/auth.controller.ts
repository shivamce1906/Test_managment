import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { AuthService } from '../services';
import { Business, Branch } from '../models';

export class AuthController {
  private authService: AuthService;

  constructor() {
    this.authService = new AuthService();
  }

  public login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '127.0.0.1';
      const result = await this.authService.login(req.body.email, req.body.password);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public refresh = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.authService.rotateRefreshToken(req.body.refreshToken);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public logout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const refreshToken = req.body?.refreshToken;
      if (refreshToken) {
        await this.authService.logout(refreshToken);
      }
      res.json({ success: true, message: 'Logged out successfully' });
    } catch (err) {
      next(err);
    }
  };

  public me = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Salon users also get their business and the branches they can open (owner: all)
      let business = null;
      let branches: unknown[] = [];
      if (req.ctx.kind === 'tenant' && req.ctx.businessId) {
        const businessId = new Types.ObjectId(req.ctx.businessId);
        const branchQuery: Record<string, unknown> = { businessId };
        if (req.ctx.role !== 'owner') {
          branchQuery._id = { $in: req.ctx.branchIds.map((id) => new Types.ObjectId(id)) };
        }
        [business, branches] = await Promise.all([
          Business.findById(businessId).select('name logoUrl status headBranchId gst.enabled').lean(),
          Branch.find(branchQuery).select('name code status').sort({ createdAt: 1 }).lean(),
        ]);
      }

      res.json({
        business,
        branches,
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
