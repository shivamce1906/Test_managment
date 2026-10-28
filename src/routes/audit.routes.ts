import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/role.middleware';
import { AuditController } from '../controllers/audit.controller';

export const auditRouter = Router();

auditRouter.use(authenticate(), requireRole('owner', 'super_admin'));

auditRouter.get('/audit-logs', AuditController.queryAuditLogs);
auditRouter.get('/audit-logs/export', AuditController.exportAuditLogs);
