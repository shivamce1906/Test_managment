import { Request, Response, NextFunction } from 'express';
import {
  authService,
  businessService,
  configureWaNumber,
  createImportJob,
  confirmImportJob,
  getImportJobs,
  queryAuditLogs,
} from '../services';

export class AdminController {
  public static async getStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.getPlatformStats();
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async listBusinesses(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.listBusinesses(req.query as any);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getBusiness(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.getBusinessDetail(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getBusinessUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.listBusinessUsers(req.params.id, req.query.role as any);
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

  public static async setUserStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.setUserStatusByAdmin(req.ctx, req.params.id, req.body.status);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async createBusiness(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.createBusiness(req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async updateBusiness(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.updateBusinessByAdmin(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async createBranch(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await businessService.createBranchByAdmin(req.ctx, req.params.id, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async deactivateBranch(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const reason = req.body?.reason || 'Deactivated by admin';
      const result = await businessService.deactivateBranchByAdmin(req.ctx, req.params.branchId, reason);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getBranchRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const status = (req.query.status as string) || 'pending';
      const requests = await businessService.getBranchRequests(status);
      res.json(requests);
    } catch (err) {
      next(err);
    }
  }

  public static async decideBranchRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { decision, note } = req.body;
      const result = await businessService.handleBranchRequest(req.ctx, req.params.id, decision, note);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async configureWaConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await configureWaNumber(req.ctx, req.body, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async createImportJob(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { type, fileKey } = req.body;
      const result = await createImportJob(req.ctx, req.params.id, type, fileKey);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async confirmImportJob(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await confirmImportJob(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getImportJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getImportJobs(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await queryAuditLogs(req.ctx, req.query as any);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}
