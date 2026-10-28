import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/role.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createBusinessSchema,
  createBranchSchema,
  updateBusinessSchema,
} from '../validations';
import { AdminController } from '../controllers/admin.controller';
import { authService } from '../services';

export const adminRouter = Router();

// All admin routes require Super Admin authentication
adminRouter.use(authenticate(), requireRole('super_admin'));

// 1. Business & Branch Lifecycle
adminRouter.post('/businesses', validate({ body: createBusinessSchema }), AdminController.createBusiness);
adminRouter.patch('/businesses/:id', validate({ body: updateBusinessSchema }), AdminController.updateBusiness);
adminRouter.post('/businesses/:id/branches', validate({ body: createBranchSchema }), AdminController.createBranch);
adminRouter.patch('/businesses/:id/branches/:branchId/deactivate', AdminController.deactivateBranch);

// 2. Branch Requests Handling
adminRouter.get('/branch-requests', AdminController.getBranchRequests);
adminRouter.post('/branch-requests/:id/decide', AdminController.decideBranchRequest);

// 3. WhatsApp Configuration for Tenant
adminRouter.post('/businesses/:id/wa-config', AdminController.configureWaConfig);

// 4. Data Migration Import Jobs
adminRouter.post('/businesses/:id/import-jobs', AdminController.createImportJob);
adminRouter.post('/import-jobs/:id/confirm', AdminController.confirmImportJob);
adminRouter.get('/businesses/:id/import-jobs', AdminController.getImportJobs);

// 5. Audit Log Inspection
adminRouter.get('/audit-logs', AdminController.getAuditLogs);

// 6. User Management
adminRouter.post('/users/:id/password', async (req, res, next) => {
  try {
    await authService.setPassword(req.ctx, req.params.id, req.body.password);
    res.status(200).json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    next(err);
  }
});
