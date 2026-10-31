import { Request, Response, NextFunction } from 'express';
import { authService, businessService } from '../services';

export class BusinessController {
  public static async getSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.getBusinessSettings(req.ctx);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async updateSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.updateBusinessSettings(req.ctx, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getBranches(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.getBranches(req.ctx);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async updateBranch(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.updateBranch(req.ctx, req.params.branchId, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async createBranchRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.createBranchRequest(req.ctx, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async createManager(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.createManager(req.ctx, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async updateManager(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.updateManager(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getManagers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.getManagers(req.ctx);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getBranchLogins(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.getBranchLogins(req.ctx);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async updateBranchLoginFlags(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.updateBranchLoginFlags(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async setUserPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await authService.setPassword(req.ctx, req.params.id, req.body.password);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
}
