import { guardedRouter } from './guarded-router';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/role.middleware';
import { AuditController } from '../controllers/audit.controller';

// Managers see their assigned branches only (enforced in queryAuditLogs)
export const auditRouter = guardedRouter(authenticate(), requireRole('owner', 'manager', 'super_admin'));

auditRouter.get('/audit-logs', AuditController.queryAuditLogs);
auditRouter.get('/audit-logs/export', AuditController.exportAuditLogs);
