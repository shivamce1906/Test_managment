import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole, requireKind } from '../middlewares/role.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  updateBusinessSettingsSchema,
  updateBranchSchema,
  createBranchRequestSchema,
  createManagerSchema,
  updateManagerSchema,
  updateBranchLoginFlagsSchema,
  passwordChangeSchema,
  idParamSchema,
  objectIdSchema,
} from '../validations';
import { BusinessController } from '../controllers/business.controller';

export const businessRouter = Router();

businessRouter.use(authenticate(), requireKind('tenant'));

// 1. Settings (Owner only)
businessRouter.get('/settings', requireRole('owner'), BusinessController.getSettings);
businessRouter.patch('/settings', requireRole('owner'), validate({ body: updateBusinessSettingsSchema }), BusinessController.updateSettings);

// 2. Branches
businessRouter.get('/branches', requireRole('owner', 'manager', 'branch'), BusinessController.getBranches);
businessRouter.patch('/branches/:branchId', requireRole('owner'), validate({ params: z.object({ branchId: objectIdSchema }), body: updateBranchSchema }), BusinessController.updateBranch);
businessRouter.post('/branch-requests', requireRole('owner'), validate({ body: createBranchRequestSchema }), BusinessController.createBranchRequest);

// 3. Managers
businessRouter.post('/managers', requireRole('owner'), validate({ body: createManagerSchema }), BusinessController.createManager);
businessRouter.patch('/managers/:id', requireRole('owner'), validate({ params: idParamSchema, body: updateManagerSchema }), BusinessController.updateManager);
businessRouter.get('/managers', requireRole('owner'), BusinessController.getManagers);

// 4. Branch Logins
businessRouter.get('/branch-logins', requireRole('owner'), BusinessController.getBranchLogins);
businessRouter.patch(
  '/branch-logins/:id',
  requireRole('owner'),
  validate({ params: idParamSchema, body: updateBranchLoginFlagsSchema }),
  BusinessController.updateBranchLoginFlags
);

// 5. Passwords: owner sets a manager's or branch login's password (sessions are revoked)
businessRouter.post(
  '/users/:id/password',
  requireRole('owner'),
  validate({ params: idParamSchema, body: passwordChangeSchema }),
  BusinessController.setUserPassword
);
