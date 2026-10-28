import { Request, Response, NextFunction } from 'express';
import {
  createLead,
  updateLead,
  getLeads,
  getLeadById,
  convertLead,
} from '../services';

export class LeadController {
  public static async createLead(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await createLead(req.ctx, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getLeads(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getLeads(req.ctx, req.query as any);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getLeadById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getLeadById(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async updateLead(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await updateLead(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async convertLead(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await convertLead(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}
