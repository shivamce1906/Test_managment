import { Request, Response, NextFunction } from 'express';
import { CatalogueService } from '../services';

export class CatalogueController {
  private catalogueService: CatalogueService;

  constructor() {
    this.catalogueService = new CatalogueService();
  }

  public createCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.catalogueService.createCategory(req.ctx, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  public getCategories = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.catalogueService.getCategories(req.ctx);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public updateCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.catalogueService.updateCategory(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public deleteCategory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.catalogueService.deleteCategory(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public createService = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.catalogueService.createService(req.ctx, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  public getServices = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const branchId = (req.query.branchId as string) || req.ctx.branchId;
      const categoryId = req.query.categoryId as string;
      const search = req.query.search as string;
      const result = await this.catalogueService.getServices(req.ctx, { branchId, categoryId, search });
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public getServiceById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const branchId = (req.query.branchId as string) || req.ctx.branchId;
      const result = await this.catalogueService.getServiceById(req.ctx, req.params.id, branchId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public updateService = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.catalogueService.updateService(req.ctx, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public deleteService = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.catalogueService.deleteService(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  public setBranchPrice = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { branchId, pricePaise } = req.body;
      const result = await this.catalogueService.setBranchPrice(req.ctx, req.params.id, branchId, pricePaise);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };
}

export const catalogueController = new CatalogueController();
