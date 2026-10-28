import { Request, Response, NextFunction } from 'express';
import { BillingService } from '../services';

export class BillingController {
  private billingService: BillingService;

  constructor() {
    this.billingService = new BillingService();
  }

  public previewBill = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.billingService.previewBill(req.ctx, req.params.branchId, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public createBill = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const idempotencyKey = (req.header('Idempotency-Key') || req.header('idempotency-key')) as string | undefined;
      const result = await this.billingService.createBill(req.ctx, req.params.branchId, req.body, idempotencyKey);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  public getBills = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.billingService.getBills(req.ctx, req.params.branchId, req.query as any);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public collectDueReceipt = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.billingService.collectDueReceipt(req.ctx, req.params.branchId, req.body.customerId, req.body.payments);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  public getApprovals = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const branchId = req.query.branchId as string;
      const result = await this.billingService.getApprovals(req.ctx, branchId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public decideBill = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { decision, reason } = req.body;
      if (decision !== 'approve' && decision !== 'reject') {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Decision must be approve or reject',
          },
        });
        return;
      }
      let result;
      if (decision === 'approve') {
        result = await this.billingService.approveBill(req.ctx, req.params.id);
      } else {
        result = await this.billingService.rejectBill(req.ctx, req.params.id, reason || 'Rejected by approver');
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public getBillById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.billingService.getBillById(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public cancelBill = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.billingService.cancelBill(req.ctx, req.params.id, req.body.reason);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public refundBill = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.billingService.refundBill(req.ctx, req.params.id, req.body.amountPaise, req.body.mode, req.body.reason);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public editBill = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.billingService.editBill(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public getCustomerDues = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const dues = await this.billingService.getCustomerDues(req.ctx, req.params.id);
      res.json(dues);
    } catch (err) {
      next(err);
    }
  };
}

export const billingController = new BillingController();
