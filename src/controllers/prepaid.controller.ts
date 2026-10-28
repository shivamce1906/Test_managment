import { Request, Response, NextFunction } from 'express';
import {
  createPlan,
  updatePlan,
  getPlans,
  getPlanById,
  extendCustomerPlan,
  freezeCustomerPlan,
  unfreezeCustomerPlan,
  transferCustomerPlan,
  getCustomerPlans,
  getCustomerPlanById,
  getWalletLedger,
  adjustWallet,
  getLoyaltyLedger,
  lookupVoucher,
} from '../services';

export class PrepaidController {
  public static async createPlan(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await createPlan(req.ctx, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getPlans(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const type = req.query.type as any;
      const result = await getPlans(req.ctx, type);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getPlanById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getPlanById(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async updatePlan(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await updatePlan(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getCustomerPlans(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getCustomerPlans(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getCustomerPlanById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getCustomerPlanById(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async extendCustomerPlan(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await extendCustomerPlan(req.ctx, req.params.id, req.body.days);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async freezeCustomerPlan(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await freezeCustomerPlan(req.ctx, req.params.id, req.body.reason);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async unfreezeCustomerPlan(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await unfreezeCustomerPlan(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async transferCustomerPlan(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await transferCustomerPlan(req.ctx, req.params.id, req.body.toCustomerId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getWalletLedger(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getWalletLedger(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async adjustWallet(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { amountPaise, reason } = req.body;
      const result = await adjustWallet(req.ctx, req.params.id, amountPaise, reason);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getLoyaltyLedger(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getLoyaltyLedger(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async lookupVoucher(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await lookupVoucher(req.ctx, req.params.code);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}
