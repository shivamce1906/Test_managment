import { Request, Response, NextFunction } from 'express';
import { AppointmentService } from '../services';

export class AppointmentController {
  private appointmentService: AppointmentService;

  constructor() {
    this.appointmentService = new AppointmentService();
  }

  public createAppointment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.appointmentService.createAppointment(req.ctx, req.params.branchId, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  public createWalkIn = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.appointmentService.createWalkIn(req.ctx, req.params.branchId, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  public getAppointments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.appointmentService.getAppointments(req.ctx, req.params.branchId, req.query as any);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public createStaffBlock = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.appointmentService.createStaffBlock(req.ctx, req.params.branchId, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  public deleteStaffBlock = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.appointmentService.deleteStaffBlock(req.ctx, req.params.blockId);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  };

  public getAppointmentById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.appointmentService.getAppointmentById(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public updateStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { status, reason } = req.body;
      const result = await this.appointmentService.updateStatus(req.ctx, req.params.id, status, reason);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };
}

export const appointmentController = new AppointmentController();
