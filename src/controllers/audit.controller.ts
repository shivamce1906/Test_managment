import { Request, Response, NextFunction } from 'express';
import { queryAuditLogs, exportAuditLogs } from '../services';

export class AuditController {
  public static async queryAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await queryAuditLogs(req.ctx, req.query as any);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async exportAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await exportAuditLogs(req.ctx, req.query as any);
      // exportAuditLogs builds an Excel workbook
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-log.xlsx"');
      res.send(result);
    } catch (err) {
      next(err);
    }
  }
}
