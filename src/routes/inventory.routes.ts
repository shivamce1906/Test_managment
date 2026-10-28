import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/role.middleware';
import { requireBranchAccess } from '../middlewares/branch.middleware';
import { requirePermission } from '../middlewares/permission.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createProductSchema,
  updateProductSchema,
  createVendorSchema,
  updateVendorSchema,
  createPurchaseOrderSchema,
  receivePurchaseOrderSchema,
  recordVendorBillSchema,
  createTransferSchema,
  receiveTransferSchema,
  createStockAuditSchema,
  adjustStockSchema,
} from '../validations';
import { inventoryController } from '../controllers/inventory.controller';

export const inventoryRouter = Router();

inventoryRouter.use(authenticate());

// 1. Products Master
inventoryRouter.post('/products', requireRole('owner', 'manager'), validate({ body: createProductSchema }), inventoryController.createProduct);
inventoryRouter.get('/products', inventoryController.getProducts);
inventoryRouter.patch('/products/:id', requireRole('owner', 'manager'), validate({ body: updateProductSchema }), inventoryController.updateProduct);

// 2. Vendors Master
inventoryRouter.post('/vendors', requireRole('owner', 'manager'), validate({ body: createVendorSchema }), inventoryController.createVendor);
inventoryRouter.get('/vendors', inventoryController.getVendors);
inventoryRouter.patch('/vendors/:id', requireRole('owner', 'manager'), validate({ body: updateVendorSchema }), inventoryController.updateVendor);

// 3. Branch Stock & Movements
inventoryRouter.get('/branches/:branchId/stock', requireBranchAccess, inventoryController.getStock);
inventoryRouter.get('/branches/:branchId/stock/movements', requireBranchAccess, inventoryController.getStockMovements);
inventoryRouter.post('/branches/:branchId/stock/adjust', requireBranchAccess, requireRole('owner', 'manager'), validate({ body: adjustStockSchema }), inventoryController.adjustStock);

// 4. Purchase Orders
inventoryRouter.post('/purchase-orders', requireRole('owner', 'manager'), validate({ body: createPurchaseOrderSchema }), inventoryController.createPurchaseOrder);
inventoryRouter.get('/purchase-orders', inventoryController.getPurchaseOrders);
inventoryRouter.post('/purchase-orders/:id/decide', requireRole('owner', 'manager'), requirePermission('approvePO'), inventoryController.decidePurchaseOrder);
inventoryRouter.post('/purchase-orders/:id/receive', requireRole('owner', 'manager'), validate({ body: receivePurchaseOrderSchema }), inventoryController.receivePurchaseOrder);
inventoryRouter.post('/purchase-orders/:id/bill', requireRole('owner', 'manager'), validate({ body: recordVendorBillSchema }), inventoryController.recordVendorBill);

// 5. Inter-Branch Transfers
inventoryRouter.post('/transfers', requireRole('owner', 'manager'), validate({ body: createTransferSchema }), inventoryController.createTransfer);
inventoryRouter.get('/transfers', inventoryController.getTransfers);
inventoryRouter.post('/transfers/:id/approve', requireRole('owner', 'manager'), inventoryController.approveTransfer);
inventoryRouter.post('/transfers/:id/dispatch', requireRole('owner', 'manager'), inventoryController.dispatchTransfer);
inventoryRouter.post('/transfers/:id/receive', requireRole('owner', 'manager'), validate({ body: receiveTransferSchema }), inventoryController.receiveTransfer);

// 6. Physical Stock Audits
inventoryRouter.post('/branches/:branchId/stock-audits', requireBranchAccess, requireRole('owner', 'manager'), validate({ body: createStockAuditSchema }), inventoryController.createStockAudit);
inventoryRouter.get('/branches/:branchId/stock-audits', requireBranchAccess, inventoryController.getStockAudits);
inventoryRouter.patch('/stock-audits/:id/counts', requireRole('owner', 'manager'), inventoryController.updateStockAuditCounts);
inventoryRouter.post('/stock-audits/:id/approve', requireRole('owner'), inventoryController.approveStockAudit);
