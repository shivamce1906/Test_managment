import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/role.middleware';
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

prepaidRouter.use(authenticate());

// 1. Plan Master CRUD
prepaidRouter.post('/plans', requireRole('owner', 'manager'), validate({ body: createPlanSchema }), PrepaidController.createPlan);
prepaidRouter.get('/plans', PrepaidController.getPlans);
prepaidRouter.get('/plans/:id', PrepaidController.getPlanById);
prepaidRouter.patch('/plans/:id', requireRole('owner', 'manager'), validate({ body: updatePlanSchema }), PrepaidController.updatePlan);

// 2. Customer Plans Management
prepaidRouter.get('/customers/:id/plans', PrepaidController.getCustomerPlans);
prepaidRouter.get('/customer-plans/:id', PrepaidController.getCustomerPlanById);
prepaidRouter.post('/customer-plans/:id/extend', requireRole('owner', 'manager'), validate({ body: extendCustomerPlanSchema }), PrepaidController.extendCustomerPlan);
prepaidRouter.post('/customer-plans/:id/freeze', requireRole('owner', 'manager'), validate({ body: freezeCustomerPlanSchema }), PrepaidController.freezeCustomerPlan);
prepaidRouter.post('/customer-plans/:id/unfreeze', requireRole('owner', 'manager'), PrepaidController.unfreezeCustomerPlan);
prepaidRouter.post('/customer-plans/:id/transfer', requireRole('owner'), validate({ body: transferCustomerPlanSchema }), PrepaidController.transferCustomerPlan);

// 3. Wallet Ledger & Adjustment
prepaidRouter.get('/customers/:id/wallet/ledger', PrepaidController.getWalletLedger);
prepaidRouter.post('/customers/:id/wallet/adjust', requireRole('owner'), validate({ body: adjustWalletSchema }), PrepaidController.adjustWallet);

// 4. Loyalty Ledger
prepaidRouter.get('/customers/:id/loyalty/ledger', PrepaidController.getLoyaltyLedger);

// 5. Voucher Lookup
prepaidRouter.get('/vouchers/:code', PrepaidController.lookupVoucher);
