import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services';

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
      res.json({
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
