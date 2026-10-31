import { guardedRouter } from './guarded-router';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole, requireKind } from '../middlewares/role.middleware';
import { requireBranchAccess } from '../middlewares/branch.middleware';
import { requirePermission } from '../middlewares/permission.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createPayrollRunSchema,
  adjustPayrollLineSchema,
  markPayrollPaidSchema,
  payrollRunsQuerySchema,
  payslipParamsSchema,
  idParamSchema,
} from '../validations';
import { PayrollController } from '../controllers/payroll.controller';

export const payrollRouter = guardedRouter(authenticate(), requireRole('owner', 'manager'), requirePermission('viewPayroll'), requireKind('tenant'));

// 1. Branch scoped runs
payrollRouter.post('/branches/:branchId/payroll-runs', requireBranchAccess, validate({ body: createPayrollRunSchema }), PayrollController.createPayrollRun);
payrollRouter.get('/branches/:branchId/payroll-runs', requireBranchAccess, validate({ query: payrollRunsQuerySchema }), PayrollController.getPayrollRuns);

// 2. Specific Run Operations
payrollRouter.get('/payroll-runs/:id', validate({ params: idParamSchema }), PayrollController.getPayrollRunById);
payrollRouter.patch('/payroll-runs/:id/adjust-line', validate({ params: idParamSchema, body: adjustPayrollLineSchema }), PayrollController.adjustPayrollLine);
payrollRouter.post('/payroll-runs/:id/review', validate({ params: idParamSchema }), PayrollController.reviewRun);
payrollRouter.post('/payroll-runs/:id/lock', requireRole('owner'), validate({ params: idParamSchema }), PayrollController.lockRun);
payrollRouter.post('/payroll-runs/:id/mark-paid', requireRole('owner'), validate({ params: idParamSchema, body: markPayrollPaidSchema }), PayrollController.markPaid);

// 3. Payslips
payrollRouter.post('/payroll-runs/:id/payslips', validate({ params: idParamSchema }), PayrollController.generatePayslips);
payrollRouter.get('/payroll-runs/:id/payslips/:staffId/pdf', validate({ params: payslipParamsSchema }), PayrollController.getPayslipPdf);
