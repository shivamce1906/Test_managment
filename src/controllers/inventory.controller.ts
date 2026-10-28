import { Request, Response, NextFunction } from 'express';
import {
  CatalogueService,
  getStockBalances,
  getStockMovements,
  adjustStock,
  createPurchaseOrder,
  approvePurchaseOrder,
  rejectPurchaseOrder,
  receivePurchaseOrder,
  recordVendorBill,
  getPurchaseOrders,
  createTransfer,
  approveTransfer,
  dispatchTransfer,
  receiveTransfer,
  getTransfers,
  createStockAudit,
  updateStockAuditCounts,
  approveStockAudit,
  getStockAudits,
} from '../services';

export class InventoryController {
  private catalogueService: CatalogueService;

  constructor() {
    this.catalogueService = new CatalogueService();
  }

  public createProduct = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.catalogueService.createProduct(req.ctx, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  public getProducts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.catalogueService.getProducts(req.ctx, req.query as any);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public updateProduct = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.catalogueService.updateProduct(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public createVendor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.catalogueService.createVendor(req.ctx, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  public getVendors = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.catalogueService.getVendors(req.ctx);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public updateVendor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.catalogueService.updateVendor(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public getStock = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const pool = req.query.pool as any;
      const result = await getStockBalances(req.ctx, req.params.branchId, { pool });
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public getStockMovements = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await getStockMovements(req.ctx, req.params.branchId, req.query as any);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public adjustStock = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await adjustStock(req.ctx, req.params.branchId, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  public createPurchaseOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await createPurchaseOrder(req.ctx, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  public getPurchaseOrders = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await getPurchaseOrders(req.ctx, req.query as any);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public decidePurchaseOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { decision, reason } = req.body;
      let result;
      if (decision === 'approve') {
        result = await approvePurchaseOrder(req.ctx, req.params.id);
      } else {
        result = await rejectPurchaseOrder(req.ctx, req.params.id, reason || 'Rejected');
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public receivePurchaseOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await receivePurchaseOrder(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public recordVendorBill = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await recordVendorBill(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public createTransfer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await createTransfer(req.ctx, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  public getTransfers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await getTransfers(req.ctx, req.query as any);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public approveTransfer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await approveTransfer(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public dispatchTransfer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await dispatchTransfer(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public receiveTransfer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await receiveTransfer(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public createStockAudit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await createStockAudit(req.ctx, req.params.branchId, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  public getStockAudits = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await getStockAudits(req.ctx, req.params.branchId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public updateStockAuditCounts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await updateStockAuditCounts(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public approveStockAudit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await approveStockAudit(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };
}

export const inventoryController = new InventoryController();
