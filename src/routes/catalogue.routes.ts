import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/role.middleware';
import { requirePermission } from '../middlewares/permission.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createCategorySchema,
  updateCategorySchema,
  createServiceSchema,
  updateServiceSchema,
} from '../validations';
import { catalogueController } from '../controllers/catalogue.controller';

export const catalogueRouter = Router();

catalogueRouter.use(authenticate());

// 1. Categories
catalogueRouter.post('/categories', requireRole('owner', 'manager'), validate({ body: createCategorySchema }), catalogueController.createCategory);
catalogueRouter.get('/categories', catalogueController.getCategories);
catalogueRouter.patch('/categories/:id', requireRole('owner', 'manager'), validate({ body: updateCategorySchema }), catalogueController.updateCategory);
catalogueRouter.delete('/categories/:id', requireRole('owner'), catalogueController.deleteCategory);

// 2. Services
catalogueRouter.post('/services', requireRole('owner', 'manager'), validate({ body: createServiceSchema }), catalogueController.createService);
catalogueRouter.get('/services', catalogueController.getServices);
catalogueRouter.get('/services/:id', catalogueController.getServiceById);
catalogueRouter.patch('/services/:id', requireRole('owner', 'manager'), validate({ body: updateServiceSchema }), catalogueController.updateService);
catalogueRouter.delete('/services/:id', requireRole('owner'), catalogueController.deleteService);
catalogueRouter.patch('/services/:id/branch-prices', requireRole('owner', 'manager'), requirePermission('editBranchPrices'), catalogueController.setBranchPrice);
