import { Request, Response, NextFunction } from 'express';
import { getDashboardKPIs, generateStandardReport, exportReportToExcel } from '../services';

export class ReportController {
  public static async getDashboard(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getDashboardKPIs(req.ctx, req.query.branchId as string | undefined);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await generateStandardReport(req.ctx, req.params.name, req.query as any);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async exportReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { from, to } = req.query as any;
      const buffer = await exportReportToExcel(req.ctx, req.params.name, req.query as any);
      const span = from ? `_${from}${to && to !== from ? `_to_${to}` : ''}` : '';
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}${span}.xlsx"`);
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  }
}
