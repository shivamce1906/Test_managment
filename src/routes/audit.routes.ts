import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/role.middleware';
import { AuditController } from '../controllers/audit.controller';

export const auditRouter = Router();

auditRouter.get(
  '/audit-logs',
  authenticate(),
  requireRole('owner', 'manager', 'super_admin'),
  AuditController.queryAuditLogs
);

auditRouter.get(
  '/audit-logs/export',
  authenticate(),
  requireRole('owner', 'super_admin'),
  AuditController.exportAuditLogs
);
