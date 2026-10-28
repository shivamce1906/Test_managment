import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole, requireKind } from '../middlewares/role.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createPlanSchema,
  updatePlanSchema,
  extendCustomerPlanSchema,
  freezeCustomerPlanSchema,
  transferCustomerPlanSchema,
  adjustWalletSchema,
} from '../validations';
import { PrepaidController } from '../controllers/prepaid.controller';

export const prepaidRouter = Router();

const prepaidAuth = [authenticate(), requireKind('tenant')];

// 1. Plan Master CRUD (PRD §3: Owner only)
prepaidRouter.post('/plans', ...prepaidAuth, requireRole('owner'), validate({ body: createPlanSchema }), PrepaidController.createPlan);
prepaidRouter.get('/plans', ...prepaidAuth, PrepaidController.getPlans);
prepaidRouter.get('/plans/:id', ...prepaidAuth, PrepaidController.getPlanById);
prepaidRouter.patch('/plans/:id', ...prepaidAuth, requireRole('owner'), validate({ body: updatePlanSchema }), PrepaidController.updatePlan);

// 2. Customer Plans Management
prepaidRouter.get('/customers/:id/plans', ...prepaidAuth, PrepaidController.getCustomerPlans);
prepaidRouter.get('/customer-plans/:id', ...prepaidAuth, PrepaidController.getCustomerPlanById);
prepaidRouter.post('/customer-plans/:id/extend', ...prepaidAuth, requireRole('owner', 'manager'), validate({ body: extendCustomerPlanSchema }), PrepaidController.extendCustomerPlan);
prepaidRouter.post('/customer-plans/:id/freeze', ...prepaidAuth, requireRole('owner', 'manager'), validate({ body: freezeCustomerPlanSchema }), PrepaidController.freezeCustomerPlan);
prepaidRouter.post('/customer-plans/:id/unfreeze', ...prepaidAuth, requireRole('owner', 'manager'), PrepaidController.unfreezeCustomerPlan);
prepaidRouter.post('/customer-plans/:id/transfer', ...prepaidAuth, requireRole('owner'), validate({ body: transferCustomerPlanSchema }), PrepaidController.transferCustomerPlan);

// 3. Wallet Ledger & Adjustment
prepaidRouter.get('/customers/:id/wallet/ledger', ...prepaidAuth, PrepaidController.getWalletLedger);
prepaidRouter.post('/customers/:id/wallet/adjust', ...prepaidAuth, requireRole('owner'), validate({ body: adjustWalletSchema }), PrepaidController.adjustWallet);

// 4. Loyalty Ledger
prepaidRouter.get('/customers/:id/loyalty/ledger', ...prepaidAuth, PrepaidController.getLoyaltyLedger);

// 5. Voucher Lookup
prepaidRouter.get('/vouchers/:code', ...prepaidAuth, PrepaidController.lookupVoucher);
