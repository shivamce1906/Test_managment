import { guardedRouter } from './guarded-router';
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
  listServicesQuerySchema,
  listCategoriesQuerySchema,
  idParamSchema,
} from '../validations';
import { catalogueController } from '../controllers/catalogue.controller';

export const catalogueRouter = guardedRouter(authenticate(), requireKind('tenant'));


// 1. Categories
catalogueRouter.post('/categories', requireRole('owner', 'manager'), validate({ body: createCategorySchema }), catalogueController.createCategory);
catalogueRouter.get('/categories', validate({ query: listCategoriesQuerySchema }), catalogueController.getCategories);
catalogueRouter.patch('/categories/:id', requireRole('owner', 'manager'), validate({ params: idParamSchema, body: updateCategorySchema }), catalogueController.updateCategory);
catalogueRouter.delete('/categories/:id', requireRole('owner'), validate({ params: idParamSchema }), catalogueController.deleteCategory);

// 2. Services
catalogueRouter.post('/services', requireRole('owner', 'manager'), validate({ body: createServiceSchema }), catalogueController.createService);
catalogueRouter.get('/services', validate({ query: listServicesQuerySchema }), catalogueController.getServices);
catalogueRouter.get('/services/:id', validate({ params: idParamSchema }), catalogueController.getServiceById);
catalogueRouter.patch('/services/:id', requireRole('owner', 'manager'), validate({ params: idParamSchema, body: updateServiceSchema }), catalogueController.updateService);
catalogueRouter.delete('/services/:id', requireRole('owner'), validate({ params: idParamSchema }), catalogueController.deleteService);
catalogueRouter.patch(
  '/services/:id/branch-prices',
  requireRole('owner', 'manager'),
  requirePermission('editBranchPrices'),
  validate({ params: idParamSchema, body: setBranchPriceSchema }),
  catalogueController.setBranchPrice
);
