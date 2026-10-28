import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole, requireKind } from '../middlewares/role.middleware';
import { requireBranchAccess } from '../middlewares/branch.middleware';
import { requirePermission } from '../middlewares/permission.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createPayrollRunSchema,
  adjustPayrollLineSchema,
  markPayrollPaidSchema,
} from '../validations';
import { PayrollController } from '../controllers/payroll.controller';

export const payrollRouter = Router();

const payrollGuard = [
  authenticate(),
  requireKind('tenant'),
  requireRole('owner', 'manager'),
  requirePermission('viewPayroll'),
];

// 1. Branch scoped runs
payrollRouter.post(
  '/branches/:branchId/payroll-runs',
  ...payrollGuard,
  requireBranchAccess,
  validate({ body: createPayrollRunSchema }),
  PayrollController.createPayrollRun
);
payrollRouter.get(
  '/branches/:branchId/payroll-runs',
  ...payrollGuard,
  requireBranchAccess,
  PayrollController.getPayrollRuns
);

// 2. Specific Run Operations
payrollRouter.get('/payroll-runs/:id', ...payrollGuard, PayrollController.getPayrollRunById);
payrollRouter.patch(
  '/payroll-runs/:id/adjust-line',
  ...payrollGuard,
  validate({ body: adjustPayrollLineSchema }),
  PayrollController.adjustPayrollLine
);
payrollRouter.post('/payroll-runs/:id/review', ...payrollGuard, PayrollController.reviewRun);
payrollRouter.post(
  '/payroll-runs/:id/lock',
  authenticate(),
  requireKind('tenant'),
  requireRole('owner'),
  PayrollController.lockRun
);
payrollRouter.post(
  '/payroll-runs/:id/mark-paid',
  authenticate(),
  requireKind('tenant'),
  requireRole('owner'),
  validate({ body: markPayrollPaidSchema }),
  PayrollController.markPaid
);
payrollRouter.post('/payroll-runs/:id/payslips', ...payrollGuard, PayrollController.generatePayslips);
