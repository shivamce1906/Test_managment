import { guardedRouter } from './guarded-router';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole, requireKind } from '../middlewares/role.middleware';
import { requireBranchAccess } from '../middlewares/branch.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createBillSchema,
  cancelBillSchema,
  refundBillSchema,
  collectDueReceiptSchema,
  editBillSchema,
  decideBillSchema,
  listBillsQuerySchema,
  approvalsQuerySchema,
  previewBillSchema,
  idParamSchema,
  invoicePdfQuerySchema,
} from '../validations';
import { billingController } from '../controllers/billing.controller';

export const billingRouter = guardedRouter(authenticate(), requireKind('tenant'));


// 1. Branch-scoped bill operations
billingRouter.post('/branches/:branchId/bills/preview', requireBranchAccess, validate({ body: previewBillSchema }), billingController.previewBill);
billingRouter.post('/branches/:branchId/bills', requireBranchAccess, validate({ body: createBillSchema }), billingController.createBill);
billingRouter.get('/branches/:branchId/bills', requireBranchAccess, validate({ query: listBillsQuerySchema }), billingController.getBills);
billingRouter.post('/branches/:branchId/due-receipts', requireBranchAccess, validate({ body: collectDueReceiptSchema }), billingController.collectDueReceipt);

// 2. Approvals
billingRouter.get('/approvals', requireRole('owner', 'manager'), validate({ query: approvalsQuerySchema }), billingController.getApprovals);
billingRouter.post('/bills/:id/decide', requireRole('owner', 'manager'), validate({ params: idParamSchema, body: decideBillSchema }), billingController.decideBill);

// 3. Single Bill Operations
billingRouter.get('/bills/:id', validate({ params: idParamSchema }), billingController.getBillById);
billingRouter.get('/bills/:id/pdf', validate({ params: idParamSchema, query: invoicePdfQuerySchema }), billingController.getInvoicePdf);
billingRouter.post('/bills/:id/cancel', requireRole('owner', 'manager'), validate({ params: idParamSchema, body: cancelBillSchema }), billingController.cancelBill);
billingRouter.post('/bills/:id/refund', requireRole('owner', 'manager'), validate({ params: idParamSchema, body: refundBillSchema }), billingController.refundBill);
billingRouter.patch('/bills/:id', requireRole('owner', 'manager'), validate({ params: idParamSchema, body: editBillSchema }), billingController.editBill);

// 4. Customer Dues
billingRouter.get('/customers/:id/dues', validate({ params: idParamSchema }), billingController.getCustomerDues);
