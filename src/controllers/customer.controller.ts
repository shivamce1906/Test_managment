import { Request, Response, NextFunction } from 'express';
import { CustomerService } from '../services';

export class CustomerController {
  private customerService: CustomerService;

  constructor() {
    this.customerService = new CustomerService();
  }

  public createCustomer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.customerService.createCustomer(req.ctx, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  public getCustomers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.customerService.getCustomers(req.ctx, req.query as any);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public exportCustomers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.customerService.exportCustomers(req.ctx);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="customers.xlsx"');
      res.send(result);
    } catch (err) {
      next(err);
    }
  };

  public mergeCustomers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { primaryId, duplicateId } = req.body;
      const result = await this.customerService.mergeCustomers(req.ctx, primaryId, duplicateId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public getCustomerById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const reveal = req.query.reveal === 'true';
      const result = await this.customerService.getCustomer(req.ctx, req.params.id, reveal);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public updateCustomer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.customerService.updateCustomer(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public revealCustomer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.customerService.getCustomer(req.ctx, req.params.id, true);
      res.json({ phone: result.phone });
    } catch (err) {
      next(err);
    }
  };

  public addServiceNote = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.customerService.addServiceNote(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public getCustomerHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.customerService.getCustomerHistory(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };
}

export const customerController = new CustomerController();
