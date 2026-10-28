import { Request, Response, NextFunction } from 'express';
import {
  createExpense,
  updateExpense,
  deleteExpense,
  getExpenses,
  createRecurringExpense,
  getRecurringExpenses,
  createPettyCashEntry,
  getPettyCashEntries,
  calculateExpected,
  getDayClosure,
  submitDayClosure,
  approveDayClosure,
  reopenDayClosure,
} from '../services';

export class DayendController {
  public static async createExpense(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await createExpense(req.ctx, req.params.branchId, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getExpenses(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getExpenses(req.ctx, req.params.branchId, req.query as any);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async updateExpense(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await updateExpense(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async deleteExpense(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await deleteExpense(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async createRecurringExpense(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await createRecurringExpense(req.ctx, req.params.branchId, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getRecurringExpenses(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getRecurringExpenses(req.ctx, req.params.branchId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async createPettyCash(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await createPettyCashEntry(req.ctx, req.params.branchId, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getPettyCash(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const date = req.query.date as string;
      const result = await getPettyCashEntries(req.ctx, req.params.branchId, date);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getDayClosure(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const existing = await getDayClosure(req.ctx, req.params.branchId, req.params.date);
      const expected = await calculateExpected(req.ctx, req.params.branchId, req.params.date);
      res.json({ existing, expected });
    } catch (err) {
      next(err);
    }
  }

  public static async submitDayClosure(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await submitDayClosure(req.ctx, req.params.branchId, req.params.date, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async approveDayClosure(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await approveDayClosure(req.ctx, req.params.branchId, req.params.date);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async reopenDayClosure(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await reopenDayClosure(req.ctx, req.params.branchId, req.params.date, {
        reason: req.body.reason || 'Reopened by owner',
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}
