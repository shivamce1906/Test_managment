import { guardedRouter } from './guarded-router';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole, requireKind } from '../middlewares/role.middleware';
import { requireBranchAccess } from '../middlewares/branch.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createExpenseSchema,
  updateExpenseSchema,
  createRecurringExpenseSchema,
  createPettyCashSchema,
  submitDayClosureSchema,
  reopenDayClosureSchema,
  listExpensesQuerySchema,
  closureParamsSchema,
  pettyCashQuerySchema,
  idParamSchema,
} from '../validations';
import { DayendController } from '../controllers/dayend.controller';

export const dayendRouter = guardedRouter(authenticate(), requireKind('tenant'));


// 1. Daily Expenses
dayendRouter.post('/branches/:branchId/expenses', requireBranchAccess, validate({ body: createExpenseSchema }), DayendController.createExpense);
dayendRouter.get('/branches/:branchId/expenses', requireBranchAccess, validate({ query: listExpensesQuerySchema }), DayendController.getExpenses);
dayendRouter.patch('/expenses/:id', requireRole('owner', 'manager'), validate({ params: idParamSchema, body: updateExpenseSchema }), DayendController.updateExpense);
dayendRouter.delete('/expenses/:id', requireRole('owner'), validate({ params: idParamSchema }), DayendController.deleteExpense);

// 2. Recurring Expenses
dayendRouter.post('/branches/:branchId/recurring-expenses', requireBranchAccess, requireRole('owner', 'manager'), validate({ body: createRecurringExpenseSchema }), DayendController.createRecurringExpense);
dayendRouter.get('/branches/:branchId/recurring-expenses', requireBranchAccess, DayendController.getRecurringExpenses);

// 3. Petty Cash Entries
dayendRouter.post('/branches/:branchId/petty-cash', requireBranchAccess, validate({ body: createPettyCashSchema }), DayendController.createPettyCash);
dayendRouter.get('/branches/:branchId/petty-cash', requireBranchAccess, validate({ query: pettyCashQuerySchema }), DayendController.getPettyCash);

// 4. Day-End Closures (BR-06)
dayendRouter.get('/branches/:branchId/closures/:date', validate({ params: closureParamsSchema }), requireBranchAccess, DayendController.getDayClosure);
dayendRouter.post('/branches/:branchId/closures/:date/submit', validate({ params: closureParamsSchema }), requireBranchAccess, validate({ body: submitDayClosureSchema }), DayendController.submitDayClosure);
dayendRouter.post('/branches/:branchId/closures/:date/approve', validate({ params: closureParamsSchema }), requireBranchAccess, requireRole('owner', 'manager'), DayendController.approveDayClosure);
dayendRouter.post('/branches/:branchId/closures/:date/reopen', validate({ params: closureParamsSchema }), requireBranchAccess, requireRole('owner'), validate({ body: reopenDayClosureSchema }), DayendController.reopenDayClosure);
