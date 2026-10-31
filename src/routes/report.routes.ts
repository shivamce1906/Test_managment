import { guardedRouter } from './guarded-router';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole, requireKind } from '../middlewares/role.middleware';
import { validate } from '../middlewares/validate.middleware';
import { reportQuerySchema } from '../validations';
import { ReportController } from '../controllers/report.controller';

export const reportRouter = guardedRouter(authenticate(), requireKind('tenant'));

// 1. Dashboard (owner: all branches or ?branchId; manager/branch login: their branches)
reportRouter.get('/dashboard', validate({ query: reportQuerySchema }), ReportController.getDashboard);

// 2. Standard reports (owner and manager; managers only for their branches)
reportRouter.get('/reports/:name', requireRole('owner', 'manager'), validate({ query: reportQuerySchema }), ReportController.getReport);

// 3. Report Excel export
reportRouter.get('/reports/:name/export', requireRole('owner', 'manager'), validate({ query: reportQuerySchema }), ReportController.exportReport);
