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
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="audit_logs.csv"');
      res.send(result);
    } catch (err) {
      next(err);
    }
  }
}
