import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/role.middleware';
import { requireBranchAccess } from '../middlewares/branch.middleware';
import { requirePermission } from '../middlewares/permission.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createPayrollRunSchema,
  adjustPayrollLineSchema,
} from '../validations';
import { PayrollController } from '../controllers/payroll.controller';

export const payrollRouter = Router();

payrollRouter.use(authenticate(), requireRole('owner', 'manager'), requirePermission('viewPayroll'));

// 1. Branch scoped runs
payrollRouter.post('/branches/:branchId/payroll-runs', requireBranchAccess, validate({ body: createPayrollRunSchema }), PayrollController.createPayrollRun);
payrollRouter.get('/branches/:branchId/payroll-runs', requireBranchAccess, PayrollController.getPayrollRuns);

// 2. Specific Run Operations
payrollRouter.get('/payroll-runs/:id', PayrollController.getPayrollRunById);
payrollRouter.patch('/payroll-runs/:id/adjust-line', validate({ body: adjustPayrollLineSchema }), PayrollController.adjustPayrollLine);
payrollRouter.post('/payroll-runs/:id/review', PayrollController.reviewRun);
payrollRouter.post('/payroll-runs/:id/lock', requireRole('owner'), PayrollController.lockRun);
payrollRouter.post('/payroll-runs/:id/mark-paid', requireRole('owner'), PayrollController.markPaid);
payrollRouter.post('/payroll-runs/:id/payslips', PayrollController.generatePayslips);
