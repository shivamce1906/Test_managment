import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/role.middleware';
import { ReportController } from '../controllers/report.controller';

export const reportRouter = Router();

reportRouter.use(authenticate());

// 1. Operational Dashboard KPIs
reportRouter.get('/dashboard', ReportController.getDashboard);

// 2. Standard Reports (15+ reports)
reportRouter.get('/reports/:name', requireRole('owner', 'manager'), ReportController.getReport);

// 3. Report Excel Export
reportRouter.get('/reports/:name/export', requireRole('owner', 'manager'), ReportController.exportReport);
