import { guardedRouter } from './guarded-router';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole, requireKind } from '../middlewares/role.middleware';
import { requirePermission } from '../middlewares/permission.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createCategorySchema,
  updateCategorySchema,
  reorderCategoriesSchema,
  createServiceSchema,
  updateServiceSchema,
  setBranchPriceSchema,
  bulkPricePreviewSchema,
  listServicesQuerySchema,
  listCategoriesQuerySchema,
  idParamSchema,
} from '../validations';
import { catalogueController } from '../controllers/catalogue.controller';

export const catalogueRouter = guardedRouter(authenticate(), requireKind('tenant'));


// 1. Categories
// Categories, services and products are owner-managed; managers need manageCatalogue (business-wide) or editBranchPrices (own branches)
catalogueRouter.post('/categories', requireRole('owner', 'manager'), requirePermission('manageCatalogue'), validate({ body: createCategorySchema }), catalogueController.createCategory);
catalogueRouter.post('/categories/reorder', requireRole('owner', 'manager'), requirePermission('manageCatalogue'), validate({ body: reorderCategoriesSchema }), catalogueController.reorderCategories);
catalogueRouter.get('/categories', validate({ query: listCategoriesQuerySchema }), catalogueController.getCategories);
catalogueRouter.patch('/categories/:id', requireRole('owner', 'manager'), requirePermission('manageCatalogue'), validate({ params: idParamSchema, body: updateCategorySchema }), catalogueController.updateCategory);
catalogueRouter.delete('/categories/:id', requireRole('owner', 'manager'), requirePermission('manageCatalogue'), validate({ params: idParamSchema }), catalogueController.deleteCategory);

// 2. Services
catalogueRouter.post('/services', requireRole('owner', 'manager'), requirePermission('manageCatalogue'), validate({ body: createServiceSchema }), catalogueController.createService);
catalogueRouter.post('/services/bulk-price/preview', requireRole('owner', 'manager'), requirePermission('manageCatalogue'), validate({ body: bulkPricePreviewSchema }), catalogueController.previewBulkPriceChange);
catalogueRouter.post('/services/bulk-price/apply', requireRole('owner', 'manager'), requirePermission('manageCatalogue'), validate({ body: bulkPricePreviewSchema }), catalogueController.applyBulkPriceChange);
catalogueRouter.get('/services', validate({ query: listServicesQuerySchema }), catalogueController.getServices);
catalogueRouter.get('/services/:id', validate({ params: idParamSchema }), catalogueController.getServiceById);
catalogueRouter.patch('/services/:id', requireRole('owner', 'manager'), requirePermission('manageCatalogue'), validate({ params: idParamSchema, body: updateServiceSchema }), catalogueController.updateService);
catalogueRouter.delete('/services/:id', requireRole('owner', 'manager'), requirePermission('manageCatalogue'), validate({ params: idParamSchema }), catalogueController.deleteService);
catalogueRouter.patch(
  '/services/:id/branch-prices',
  requireRole('owner', 'manager'),
  requirePermission('editBranchPrices'),
  validate({ params: idParamSchema, body: setBranchPriceSchema }),
  catalogueController.setBranchPrice
);
