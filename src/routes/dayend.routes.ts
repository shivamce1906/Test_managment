import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/role.middleware';
import { requireBranchAccess } from '../middlewares/branch.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createExpenseSchema,
  updateExpenseSchema,
  createRecurringExpenseSchema,
  createPettyCashSchema,
  submitDayClosureSchema,
  reopenDayClosureSchema,
  dayClosureParamsSchema,
} from '../validations';
import { DayendController } from '../controllers/dayend.controller';

export const dayendRouter = Router();

dayendRouter.use(authenticate());

// 1. Daily Expenses
dayendRouter.post('/branches/:branchId/expenses', requireBranchAccess, validate({ body: createExpenseSchema }), DayendController.createExpense);
dayendRouter.get('/branches/:branchId/expenses', requireBranchAccess, DayendController.getExpenses);
dayendRouter.patch('/expenses/:id', requireRole('owner', 'manager'), validate({ body: updateExpenseSchema }), DayendController.updateExpense);
dayendRouter.delete('/expenses/:id', requireRole('owner'), DayendController.deleteExpense);

// 2. Recurring Expenses
dayendRouter.post('/branches/:branchId/recurring-expenses', requireBranchAccess, requireRole('owner', 'manager'), validate({ body: createRecurringExpenseSchema }), DayendController.createRecurringExpense);
dayendRouter.get('/branches/:branchId/recurring-expenses', requireBranchAccess, DayendController.getRecurringExpenses);

// 3. Petty Cash Entries
dayendRouter.post('/branches/:branchId/petty-cash', requireBranchAccess, validate({ body: createPettyCashSchema }), DayendController.createPettyCash);
dayendRouter.get('/branches/:branchId/petty-cash', requireBranchAccess, DayendController.getPettyCash);

// 4. Day-End Closures (BR-06)
dayendRouter.get('/branches/:branchId/closures/:date', requireBranchAccess, validate({ params: dayClosureParamsSchema }), DayendController.getDayClosure);
dayendRouter.post('/branches/:branchId/closures/:date/submit', requireBranchAccess, validate({ params: dayClosureParamsSchema, body: submitDayClosureSchema }), DayendController.submitDayClosure);
dayendRouter.post('/branches/:branchId/closures/:date/approve', requireBranchAccess, validate({ params: dayClosureParamsSchema }), requireRole('owner', 'manager'), DayendController.approveDayClosure);
dayendRouter.post('/branches/:branchId/closures/:date/reopen', requireBranchAccess, validate({ params: dayClosureParamsSchema, body: reopenDayClosureSchema }), requireRole('owner'), DayendController.reopenDayClosure);
