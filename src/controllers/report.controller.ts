import { Request, Response, NextFunction } from 'express';
import {
  getDashboardKPIs,
  generateStandardReport,
  exportReportToExcel,
} from '../services';

export class ReportController {
  public static async getDashboard(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const branchId = (req.query.branchId as string) || req.ctx.branchId;
      const result = await getDashboardKPIs(req.ctx, branchId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const reportName = req.params.name as any;
      const params = {
        branchId: (req.query.branchId as string) || req.ctx.branchId,
        from: (req.query.from as string) || (req.query.fromDate as string),
        to: (req.query.to as string) || (req.query.toDate as string),
        fromDate: (req.query.from as string) || (req.query.fromDate as string),
        toDate: (req.query.to as string) || (req.query.toDate as string),
        staffId: req.query.staffId as string,
        customerId: req.query.customerId as string,
      };
      const result = await generateStandardReport(req.ctx, reportName, params);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async exportReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const reportName = req.params.name as any;
      const params = {
        branchId: (req.query.branchId as string) || req.ctx.branchId,
        from: (req.query.from as string) || (req.query.fromDate as string),
        to: (req.query.to as string) || (req.query.toDate as string),
        fromDate: (req.query.from as string) || (req.query.fromDate as string),
        toDate: (req.query.to as string) || (req.query.toDate as string),
      };
      const buffer = await exportReportToExcel(req.ctx, reportName, params);

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${reportName}_report.xlsx"`);
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  }
}
