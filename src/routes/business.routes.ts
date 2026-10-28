import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/role.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  updateBusinessSettingsSchema,
  updateBranchSchema,
  createBranchRequestSchema,
  createManagerSchema,
  updateManagerSchema,
} from '../validations';
import { BusinessController } from '../controllers/business.controller';

export const businessRouter = Router();

businessRouter.use(authenticate());

// 1. Settings (Owner only)
businessRouter.get('/settings', requireRole('owner'), BusinessController.getSettings);
businessRouter.patch('/settings', requireRole('owner'), validate({ body: updateBusinessSettingsSchema }), BusinessController.updateSettings);

// 2. Branches
businessRouter.get('/branches', requireRole('owner', 'manager', 'branch'), BusinessController.getBranches);
businessRouter.patch('/branches/:branchId', requireRole('owner'), validate({ body: updateBranchSchema }), BusinessController.updateBranch);
businessRouter.post('/branch-requests', requireRole('owner'), validate({ body: createBranchRequestSchema }), BusinessController.createBranchRequest);

// 3. Managers
businessRouter.post('/managers', requireRole('owner'), validate({ body: createManagerSchema }), BusinessController.createManager);
businessRouter.patch('/managers/:id', requireRole('owner'), validate({ body: updateManagerSchema }), BusinessController.updateManager);
businessRouter.get('/managers', requireRole('owner'), BusinessController.getManagers);

// 4. Branch Logins
businessRouter.get('/branch-logins', requireRole('owner'), BusinessController.getBranchLogins);
businessRouter.patch('/branch-logins/:id', requireRole('owner'), BusinessController.updateBranchLoginFlags);
