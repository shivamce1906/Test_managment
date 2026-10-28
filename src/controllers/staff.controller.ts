import { Request, Response, NextFunction } from 'express';
import { getBusinessDate } from '../utils';
import {
  createStaff,
  updateStaff,
  getStaffList,
  getStaffById,
  getBilledByStaff,
  getRoster,
  updateRoster,
  getAttendance,
  markAttendance,
  createLeave,
  updateLeaveStatus,
  getLeaves,
  createAdvance,
  getAdvances,
} from '../services';

export class StaffController {
  public static async createStaff(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await createStaff(req.ctx, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getStaffList(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getStaffList(req.ctx, req.query as any);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getStaffById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getStaffById(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async updateStaff(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await updateStaff(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getRoster(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getRoster(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async updateRoster(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await updateRoster(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getAttendance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const date = (req.query.date as string) || getBusinessDate();
      const result = await getAttendance(req.ctx, req.params.branchId, date);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async markAttendance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const date = (req.query.date as string) || (req.body.businessDate as string) || getBusinessDate();
      const result = await markAttendance(req.ctx, req.params.branchId, date, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getLeaves(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getLeaves(req.ctx, req.params.branchId, req.query as any);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async createLeave(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await createLeave(req.ctx, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async updateLeaveStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await updateLeaveStatus(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getAdvances(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getAdvances(req.ctx, { branchId: req.params.branchId, ...req.query });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async createAdvance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await createAdvance(req.ctx, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getBilledBy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getBilledByStaff(req.ctx, req.params.branchId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}
