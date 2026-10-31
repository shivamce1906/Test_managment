import { guardedRouter } from './guarded-router';
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
  listPlansQuerySchema,
  idParamSchema,
} from '../validations';
import { PrepaidController } from '../controllers/prepaid.controller';

export const prepaidRouter = guardedRouter(authenticate(), requireKind('tenant'));


// 1. Plan Master CRUD
prepaidRouter.post('/plans', requireRole('owner'), validate({ body: createPlanSchema }), PrepaidController.createPlan);
prepaidRouter.get('/plans', validate({ query: listPlansQuerySchema }), PrepaidController.getPlans);
prepaidRouter.get('/plans/:id', validate({ params: idParamSchema }), PrepaidController.getPlanById);
prepaidRouter.patch('/plans/:id', requireRole('owner'), validate({ params: idParamSchema, body: updatePlanSchema }), PrepaidController.updatePlan);

// 2. Customer Plans Management
prepaidRouter.get('/customers/:id/plans', validate({ params: idParamSchema }), PrepaidController.getCustomerPlans);
prepaidRouter.get('/customer-plans/:id', validate({ params: idParamSchema }), PrepaidController.getCustomerPlanById);
prepaidRouter.post('/customer-plans/:id/extend', requireRole('owner', 'manager'), validate({ body: extendCustomerPlanSchema }), PrepaidController.extendCustomerPlan);
prepaidRouter.post('/customer-plans/:id/freeze', requireRole('owner', 'manager'), validate({ body: freezeCustomerPlanSchema }), PrepaidController.freezeCustomerPlan);
prepaidRouter.post('/customer-plans/:id/unfreeze', requireRole('owner', 'manager'), PrepaidController.unfreezeCustomerPlan);
prepaidRouter.post('/customer-plans/:id/transfer', requireRole('owner'), validate({ body: transferCustomerPlanSchema }), PrepaidController.transferCustomerPlan);

// 3. Wallet Ledger & Adjustment
prepaidRouter.get('/customers/:id/wallet', validate({ params: idParamSchema }), PrepaidController.getWallet);
prepaidRouter.get('/customers/:id/wallet/ledger', validate({ params: idParamSchema }), PrepaidController.getWalletLedger);
prepaidRouter.post('/customers/:id/wallet/adjust', requireRole('owner'), validate({ body: adjustWalletSchema }), PrepaidController.adjustWallet);

// 4. Loyalty Ledger
prepaidRouter.get('/customers/:id/loyalty', validate({ params: idParamSchema }), PrepaidController.getLoyalty);
prepaidRouter.get('/customers/:id/loyalty/ledger', validate({ params: idParamSchema }), PrepaidController.getLoyaltyLedger);

// 5. Voucher Lookup
prepaidRouter.get('/vouchers/:code', PrepaidController.lookupVoucher);
