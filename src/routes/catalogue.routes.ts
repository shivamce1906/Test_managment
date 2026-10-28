import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole, requireKind } from '../middlewares/role.middleware';
import { requirePermission } from '../middlewares/permission.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createCategorySchema,
  updateCategorySchema,
  createServiceSchema,
  updateServiceSchema,
  setBranchPriceSchema,
} from '../validations';
import { catalogueController } from '../controllers/catalogue.controller';

export const catalogueRouter = Router();

catalogueRouter.use('/categories', authenticate(), requireKind('tenant'));
catalogueRouter.use('/services', authenticate(), requireKind('tenant'));

// 1. Categories (PRD §3: Owner only creates/updates/deletes)
catalogueRouter.post('/categories', requireRole('owner'), validate({ body: createCategorySchema }), catalogueController.createCategory);
catalogueRouter.get('/categories', catalogueController.getCategories);
catalogueRouter.patch('/categories/:id', requireRole('owner'), validate({ body: updateCategorySchema }), catalogueController.updateCategory);
catalogueRouter.delete('/categories/:id', requireRole('owner'), catalogueController.deleteCategory);

// 2. Services (PRD §3: Owner creates/updates master; Manager views only, can edit branch prices with permission)
catalogueRouter.post('/services', requireRole('owner'), validate({ body: createServiceSchema }), catalogueController.createService);
catalogueRouter.get('/services', catalogueController.getServices);
catalogueRouter.get('/services/:id', catalogueController.getServiceById);
catalogueRouter.patch('/services/:id', requireRole('owner'), validate({ body: updateServiceSchema }), catalogueController.updateService);
catalogueRouter.delete('/services/:id', requireRole('owner'), catalogueController.deleteService);
catalogueRouter.patch('/services/:id/branch-prices', requireRole('owner', 'manager'), requirePermission('editBranchPrices'), validate({ body: setBranchPriceSchema }), catalogueController.setBranchPrice);
