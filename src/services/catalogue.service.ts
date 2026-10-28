import { Types } from 'mongoose';
import {
  Category,
  Service,
  Product,
  Vendor,
  Bill,
  ICategory,
  IService,
  IProduct,
  IVendor,
} from '../models';
import { AppError } from '../utils';
import { RequestContext, toObjectId } from './context';
import { auditService } from './audit.service';

export class CatalogueService {
  // --- CATEGORIES ---

  async createCategory(ctx: RequestContext, data: any): Promise<ICategory> {
    if (ctx.role !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only owner can create categories');
    }

    const businessId = toObjectId(ctx.businessId!);

    if (data.parentId) {
      const parent = await Category.findOne({ _id: toObjectId(data.parentId), businessId });
      if (!parent) {
        throw new AppError(404, 'NOT_FOUND', 'Parent category not found');
      }
      if (parent.parentId) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Maximum 2 levels of categories allowed');
      }
    }

    const category = new Category({
      businessId,
      name: data.name,
      parentId: data.parentId ? toObjectId(data.parentId) : undefined,
      gender: data.gender,
      order: data.order || 0,
      active: data.active !== undefined ? data.active : true,
    });
    await category.save();

    await auditService.logAction({
      ctx,
      action: 'category.create',
      entity: 'category',
      entityId: category._id,
      after: { name: category.name },
    });

    return category;
  }

  async updateCategory(ctx: RequestContext, id: string, updates: any): Promise<ICategory> {
    if (ctx.role !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only owner can update categories');
    }

    const businessId = toObjectId(ctx.businessId!);
    const category = await Category.findOne({ _id: toObjectId(id), businessId });
    if (!category) {
      throw new AppError(404, 'NOT_FOUND', 'Category not found');
    }

    const before = category.toObject();

    if (updates.parentId !== undefined) {
      if (updates.parentId) {
        const parent = await Category.findOne({ _id: toObjectId(updates.parentId), businessId });
        if (!parent || parent._id.equals(category._id)) {
          throw new AppError(400, 'VALIDATION_ERROR', 'Invalid parent category');
        }
        category.parentId = parent._id;
      } else {
        category.parentId = undefined;
      }
    }

    if (updates.name) category.name = updates.name;
    if (updates.gender) category.gender = updates.gender;
    if (updates.order !== undefined) category.order = updates.order;
    if (updates.active !== undefined) category.active = updates.active;

    await category.save();

    await auditService.logAction({
      ctx,
      action: 'category.update',
      entity: 'category',
      entityId: category._id,
      before,
      after: updates,
    });

    return category;
  }

  async reorderCategories(ctx: RequestContext, orders: { id: string; order: number }[]): Promise<void> {
    if (ctx.role !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only owner can reorder categories');
    }
    const businessId = toObjectId(ctx.businessId!);

    for (const item of orders) {
      await Category.updateOne({ _id: toObjectId(item.id), businessId }, { $set: { order: item.order } });
    }
  }

  async getCategories(ctx: RequestContext): Promise<ICategory[]> {
    const businessId = toObjectId(ctx.businessId!);
    return Category.find({ businessId }).sort({ order: 1, name: 1 });
  }

  // --- SERVICES ---

  async createService(ctx: RequestContext, data: any): Promise<IService> {
    if (ctx.role !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only owner can create services');
    }

    const businessId = toObjectId(ctx.businessId!);

    const category = await Category.findOne({ _id: toObjectId(data.categoryId), businessId });
    if (!category) {
      throw new AppError(404, 'NOT_FOUND', 'Category not found');
    }

    const service = new Service({
      businessId,
      categoryId: category._id,
      name: data.name,
      gender: data.gender,
      basePricePaise: data.basePricePaise,
      durationMin: data.durationMin,
      branchPrices: (data.branchPrices || []).map((bp: any) => ({
        branchId: toObjectId(bp.branchId),
        pricePaise: bp.pricePaise,
        active: bp.active !== undefined ? bp.active : true,
      })),
      consumables: (data.consumables || []).map((c: any) => ({
        productId: toObjectId(c.productId),
        qty: c.qty,
      })),
      rebookDays: data.rebookDays,
      eligibleStaffIds: (data.eligibleStaffIds || []).map(toObjectId),
      commission: data.commission,
      active: data.active !== undefined ? data.active : true,
    });
    await service.save();

    await auditService.logAction({
      ctx,
      action: 'service.create',
      entity: 'service',
      entityId: service._id,
      after: { name: service.name, basePricePaise: service.basePricePaise },
    });

    return service;
  }

  async updateService(ctx: RequestContext, id: string, updates: any): Promise<IService> {
    const businessId = toObjectId(ctx.businessId!);
    const service = await Service.findOne({ _id: toObjectId(id), businessId });
    if (!service) {
      throw new AppError(404, 'NOT_FOUND', 'Service not found');
    }

    const before = service.toObject();

    // Manager with editBranchPrices flag can only update branchPrices for assigned branches
    if (ctx.role === 'manager') {
      if (!updates.branchPrices) {
        throw new AppError(403, 'FORBIDDEN', 'Managers can only edit branch prices');
      }

      for (const bp of updates.branchPrices) {
        const bpBranchId = bp.branchId.toString();
        if (!ctx.branchIds.includes(bpBranchId)) {
          throw new AppError(403, 'FORBIDDEN', `Cannot modify price for unassigned branch ${bpBranchId}`);
        }
        const existingIdx = service.branchPrices.findIndex((p) => p.branchId.toString() === bpBranchId);
        if (existingIdx >= 0) {
          service.branchPrices[existingIdx].pricePaise = bp.pricePaise;
          if (bp.active !== undefined) service.branchPrices[existingIdx].active = bp.active;
        } else {
          service.branchPrices.push({
            branchId: toObjectId(bp.branchId),
            pricePaise: bp.pricePaise,
            active: bp.active !== undefined ? bp.active : true,
          });
        }
      }
    } else if (ctx.role === 'owner') {
      // Owner can update everything
      if (updates.categoryId) service.categoryId = toObjectId(updates.categoryId);
      if (updates.name) service.name = updates.name;
      if (updates.gender) service.gender = updates.gender;
      if (updates.basePricePaise !== undefined) service.basePricePaise = updates.basePricePaise;
      if (updates.durationMin !== undefined) service.durationMin = updates.durationMin;
      if (updates.branchPrices) {
        service.branchPrices = updates.branchPrices.map((bp: any) => ({
          branchId: toObjectId(bp.branchId),
          pricePaise: bp.pricePaise,
          active: bp.active !== undefined ? bp.active : true,
        }));
      }
      if (updates.consumables) {
        service.consumables = updates.consumables.map((c: any) => ({
          productId: toObjectId(c.productId),
          qty: c.qty,
        }));
      }
      if (updates.rebookDays !== undefined) service.rebookDays = updates.rebookDays;
      if (updates.eligibleStaffIds) service.eligibleStaffIds = updates.eligibleStaffIds.map(toObjectId);
      if (updates.commission) service.commission = updates.commission;
      if (updates.active !== undefined) service.active = updates.active;
    } else {
      throw new AppError(403, 'FORBIDDEN', 'Branch login cannot edit services');
    }

    await service.save();

    await auditService.logAction({
      ctx,
      action: 'service.update',
      entity: 'service',
      entityId: service._id,
      before,
      after: updates,
    });

    return service;
  }

  async deleteOrDeactivateService(ctx: RequestContext, id: string): Promise<IService> {
    if (ctx.role !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only owner can deactivate services');
    }
    const businessId = toObjectId(ctx.businessId!);
    const service = await Service.findOne({ _id: toObjectId(id), businessId });
    if (!service) {
      throw new AppError(404, 'NOT_FOUND', 'Service not found');
    }

    // Check if past bills exist with this service
    const hasBills = await Bill.findOne({
      businessId,
      'lines.refId': service._id,
      'lines.kind': 'service',
    });

    if (hasBills) {
      // Cannot delete, must deactivate per FR-SVC-07
      service.active = false;
      await service.save();
      return service;
    }

    // If no bills, mark deactivated/inactive
    service.active = false;
    await service.save();
    return service;
  }

  async getServices(
    ctx: RequestContext,
    filters: { branchId?: string; categoryId?: string; active?: boolean; search?: string }
  ): Promise<any[]> {
    const businessId = toObjectId(ctx.businessId!);
    const query: any = { businessId };

    if (filters.categoryId) query.categoryId = toObjectId(filters.categoryId);
    if (filters.active !== undefined) query.active = filters.active;
    if (filters.search) query.name = { $regex: filters.search, $options: 'i' };

    const services = await Service.find(query).sort({ name: 1 });

    const branchIdStr = filters.branchId || (ctx.branchIds.length === 1 ? ctx.branchIds[0] : null);

    return services.map((svc) => {
      const obj: any = svc.toObject();
      let effectivePricePaise = svc.basePricePaise;
      let branchActive = svc.active;

      if (branchIdStr) {
        const bp = svc.branchPrices.find((p) => p.branchId.toString() === branchIdStr);
        if (bp) {
          if (bp.pricePaise !== undefined && bp.pricePaise !== null) {
            effectivePricePaise = bp.pricePaise;
          }
          branchActive = bp.active;
        }
      }

      obj.effectivePricePaise = effectivePricePaise;
      obj.branchActive = branchActive;
      return obj;
    });
  }

  async getServiceById(ctx: RequestContext, serviceId: string, branchId?: string): Promise<any> {
    const list = await this.getServices(ctx, { branchId });
    const svc = list.find((s) => s._id.toString() === serviceId);
    if (!svc) {
      throw new AppError(404, 'NOT_FOUND', 'Service not found');
    }
    return svc;
  }

  async deleteCategory(ctx: RequestContext, id: string): Promise<void> {
    const businessId = toObjectId(ctx.businessId!);
    await Category.updateOne({ _id: toObjectId(id), businessId }, { $set: { active: false } });
  }

  async deleteService(ctx: RequestContext, id: string): Promise<void> {
    const businessId = toObjectId(ctx.businessId!);
    await Service.updateOne({ _id: toObjectId(id), businessId }, { $set: { active: false } });
  }

  async setBranchPrice(ctx: RequestContext, serviceId: string, branchId: string, pricePaise: number): Promise<IService> {
    const businessId = toObjectId(ctx.businessId!);
    const service = await Service.findOne({ _id: toObjectId(serviceId), businessId });
    if (!service) {
      throw new AppError(404, 'NOT_FOUND', 'Service not found');
    }
    const idx = service.branchPrices.findIndex((bp) => bp.branchId.toString() === branchId);
    if (idx >= 0) {
      service.branchPrices[idx].pricePaise = pricePaise;
    } else {
      service.branchPrices.push({
        branchId: toObjectId(branchId),
        pricePaise,
        active: true,
      });
    }
    await service.save();
    return service;
  }

  /**
   * Bulk price change preview and apply.
   */
  async previewBulkPriceChange(
    ctx: RequestContext,
    categoryId: string,
    changeBps: number,
    branchId?: string
  ): Promise<any[]> {
    const services = await this.getServices(ctx, { categoryId, branchId });
    return services.map((svc) => {
      const oldPrice = svc.effectivePricePaise;
      const delta = Math.round((oldPrice * changeBps) / 10000);
      const newPrice = Math.max(0, oldPrice + delta);
      return {
        serviceId: svc._id,
        name: svc.name,
        oldPricePaise: oldPrice,
        newPricePaise: newPrice,
        changeBps,
      };
    });
  }

  async applyBulkPriceChange(
    ctx: RequestContext,
    categoryId: string,
    changeBps: number,
    branchId?: string
  ): Promise<{ updatedCount: number }> {
    if (ctx.role !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only owner can apply bulk price changes');
    }

    const businessId = toObjectId(ctx.businessId!);
    const services = await Service.find({ businessId, categoryId: toObjectId(categoryId) });

    for (const svc of services) {
      if (branchId) {
        // Update specific branch
        const bpIdx = svc.branchPrices.findIndex((p) => p.branchId.toString() === branchId);
        const currentPrice = bpIdx >= 0 && svc.branchPrices[bpIdx].pricePaise !== undefined
          ? svc.branchPrices[bpIdx].pricePaise!
          : svc.basePricePaise;

        const delta = Math.round((currentPrice * changeBps) / 10000);
        const newPrice = Math.max(0, currentPrice + delta);

        if (bpIdx >= 0) {
          svc.branchPrices[bpIdx].pricePaise = newPrice;
        } else {
          svc.branchPrices.push({
            branchId: toObjectId(branchId),
            pricePaise: newPrice,
            active: true,
          });
        }
      } else {
        // Update base price
        const delta = Math.round((svc.basePricePaise * changeBps) / 10000);
        svc.basePricePaise = Math.max(0, svc.basePricePaise + delta);
      }
      await svc.save();
    }

    await auditService.logAction({
      ctx,
      action: 'service.bulk_price_change',
      entity: 'service',
      reason: `Bulk price change ${changeBps} bps for category ${categoryId}`,
      after: { categoryId, changeBps, branchId, count: services.length },
    });

    return { updatedCount: services.length };
  }

  // --- PRODUCTS ---

  async createProduct(ctx: RequestContext, data: any): Promise<IProduct> {
    if (ctx.role !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only owner can create products');
    }

    const businessId = toObjectId(ctx.businessId!);
    const product = new Product({
      businessId,
      name: data.name,
      brand: data.brand,
      category: data.category,
      type: data.type,
      sku: data.sku,
      purchaseUnit: data.purchaseUnit,
      useUnit: data.useUnit,
      unitsPerPurchase: data.unitsPerPurchase,
      mrpPaise: data.mrpPaise,
      sellingPricePaise: data.sellingPricePaise,
      purchasePricePaise: data.purchasePricePaise,
      hsn: data.hsn,
      gstBps: data.gstBps,
      reorderLevels: (data.reorderLevels || []).map((rl: any) => ({
        branchId: toObjectId(rl.branchId),
        qty: rl.qty,
      })),
      active: data.active !== undefined ? data.active : true,
    });
    await product.save();

    await auditService.logAction({
      ctx,
      action: 'product.create',
      entity: 'product',
      entityId: product._id,
      after: { name: product.name, type: product.type },
    });

    return product;
  }

  async updateProduct(ctx: RequestContext, id: string, updates: any): Promise<IProduct> {
    if (ctx.role !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only owner can update products');
    }

    const businessId = toObjectId(ctx.businessId!);
    const product = await Product.findOne({ _id: toObjectId(id), businessId });
    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    const before = product.toObject();
    Object.assign(product, updates);
    if (updates.reorderLevels) {
      product.reorderLevels = updates.reorderLevels.map((rl: any) => ({
        branchId: toObjectId(rl.branchId),
        qty: rl.qty,
      }));
    }
    await product.save();

    await auditService.logAction({
      ctx,
      action: 'product.update',
      entity: 'product',
      entityId: product._id,
      before,
      after: updates,
    });

    return product;
  }

  async getProducts(ctx: RequestContext, filters: { type?: string; active?: boolean }): Promise<IProduct[]> {
    const businessId = toObjectId(ctx.businessId!);
    const query: any = { businessId };
    if (filters.type) {
      query.type = { $in: [filters.type, 'both'] };
    }
    if (filters.active !== undefined) {
      query.active = filters.active;
    }
    return Product.find(query).sort({ name: 1 });
  }

  // --- VENDORS ---

  async createVendor(ctx: RequestContext, data: any): Promise<IVendor> {
    const businessId = toObjectId(ctx.businessId!);
    const vendor = new Vendor({
      businessId,
      name: data.name,
      contact: data.contact,
      phone: data.phone,
      gstin: data.gstin,
      address: data.address,
      terms: data.terms,
    });
    await vendor.save();
    return vendor;
  }

  async getVendors(ctx: RequestContext): Promise<IVendor[]> {
    const businessId = toObjectId(ctx.businessId!);
    return Vendor.find({ businessId }).sort({ name: 1 });
  }

  async updateVendor(ctx: RequestContext, id: string, data: any): Promise<IVendor> {
    const businessId = toObjectId(ctx.businessId!);
    const vendor = await Vendor.findOne({ _id: toObjectId(id), businessId });
    if (!vendor) {
      throw new AppError(404, 'NOT_FOUND', 'Vendor not found');
    }
    Object.assign(vendor, data);
    await vendor.save();
    return vendor;
  }
}

export const catalogueService = new CatalogueService();
