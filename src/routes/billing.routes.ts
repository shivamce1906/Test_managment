import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/role.middleware';
import { requireBranchAccess } from '../middlewares/branch.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createBillSchema,
  cancelBillSchema,
  refundBillSchema,
  collectDueReceiptSchema,
} from '../validations';
import { billingController } from '../controllers/billing.controller';

export const billingRouter = Router();

billingRouter.use(authenticate());

// 1. Branch-scoped bill operations
billingRouter.post('/branches/:branchId/bills/preview', requireBranchAccess, billingController.previewBill);
billingRouter.post('/branches/:branchId/bills', requireBranchAccess, validate({ body: createBillSchema }), billingController.createBill);
billingRouter.get('/branches/:branchId/bills', requireBranchAccess, billingController.getBills);
billingRouter.post('/branches/:branchId/due-receipts', requireBranchAccess, validate({ body: collectDueReceiptSchema }), billingController.collectDueReceipt);

// 2. Approvals
billingRouter.get('/approvals', requireRole('owner', 'manager'), billingController.getApprovals);
billingRouter.post('/bills/:id/decide', requireRole('owner', 'manager'), billingController.decideBill);

// 3. Single Bill Operations
billingRouter.get('/bills/:id', billingController.getBillById);
billingRouter.post('/bills/:id/cancel', requireRole('owner', 'manager'), validate({ body: cancelBillSchema }), billingController.cancelBill);
billingRouter.post('/bills/:id/refund', requireRole('owner', 'manager'), validate({ body: refundBillSchema }), billingController.refundBill);
billingRouter.patch('/bills/:id', requireRole('owner', 'manager'), billingController.editBill);

// 4. Customer Dues
billingRouter.get('/customers/:id/dues', billingController.getCustomerDues);
