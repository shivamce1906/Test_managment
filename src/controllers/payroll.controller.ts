import { Request, Response, NextFunction } from 'express';
import {
  createMonthlyRun,
  adjustPayrollLine,
  reviewRun,
  lockRun,
  markPaid,
  generatePayslipsForRun,
  getPayrollRuns,
  getPayrollRunById,
} from '../services';

export class PayrollController {
  public static async createPayrollRun(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await createMonthlyRun(req.ctx, req.params.branchId, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getPayrollRuns(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getPayrollRuns(req.ctx, req.params.branchId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getPayrollRunById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getPayrollRunById(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async adjustPayrollLine(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await adjustPayrollLine(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async reviewRun(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await reviewRun(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async lockRun(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await lockRun(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async markPaid(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await markPaid(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async generatePayslips(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await generatePayslipsForRun(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}
