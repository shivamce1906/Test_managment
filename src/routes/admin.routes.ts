import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/role.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createBusinessSchema,
  createBranchSchema,
  updateBusinessSchema,
  adminListBusinessesQuerySchema,
  adminBusinessUsersQuerySchema,
  adminUserStatusSchema,
  idParamSchema,
  passwordChangeSchema,
  decideBranchRequestSchema,
  configureWaNumberSchema,
} from '../validations';
import { AdminController } from '../controllers/admin.controller';

const createImportJobSchema = z.object({
  type: z.enum(['customers', 'services', 'products', 'staff', 'plans', 'wallet']),
  fileKey: z.string().min(1),
});

export const adminRouter = Router();

// All admin routes require Super Admin authentication
adminRouter.use(authenticate(), requireRole('super_admin'));

// 0. Platform dashboard
adminRouter.get('/stats', AdminController.getStats);

// 1. Business & Branch Lifecycle
adminRouter.get('/businesses', validate({ query: adminListBusinessesQuerySchema }), AdminController.listBusinesses);
adminRouter.post('/businesses', validate({ body: createBusinessSchema }), AdminController.createBusiness);
adminRouter.get('/businesses/:id', validate({ params: idParamSchema }), AdminController.getBusiness);
adminRouter.patch('/businesses/:id', validate({ params: idParamSchema, body: updateBusinessSchema }), AdminController.updateBusiness);
adminRouter.post('/businesses/:id/branches', validate({ body: createBranchSchema }), AdminController.createBranch);
adminRouter.patch('/businesses/:id/branches/:branchId/deactivate', AdminController.deactivateBranch);

// 1b. Salon users (owner, managers, branch logins)
adminRouter.get(
  '/businesses/:id/users',
  validate({ params: idParamSchema, query: adminBusinessUsersQuerySchema }),
  AdminController.getBusinessUsers
);
adminRouter.post('/users/:id/password', validate({ params: idParamSchema, body: passwordChangeSchema }), AdminController.setUserPassword);
adminRouter.post('/users/:id/status', validate({ params: idParamSchema, body: adminUserStatusSchema }), AdminController.setUserStatus);

// 2. Branch Requests Handling
adminRouter.get('/branch-requests', AdminController.getBranchRequests);
adminRouter.post(
  '/branch-requests/:id/decide',
  validate({ params: idParamSchema, body: decideBranchRequestSchema }),
  AdminController.decideBranchRequest
);

// 3. WhatsApp Configuration for Tenant
adminRouter.post('/businesses/:id/wa-config', validate({ params: idParamSchema, body: configureWaNumberSchema }), AdminController.configureWaConfig);

// 4. Data Migration Import Jobs
adminRouter.post('/businesses/:id/import-jobs', validate({ params: idParamSchema, body: createImportJobSchema }), AdminController.createImportJob);
adminRouter.post('/import-jobs/:id/confirm', validate({ params: idParamSchema }), AdminController.confirmImportJob);
adminRouter.get('/businesses/:id/import-jobs', validate({ params: idParamSchema }), AdminController.getImportJobs);

// 5. Audit Log Inspection
adminRouter.get('/audit-logs', AdminController.getAuditLogs);
