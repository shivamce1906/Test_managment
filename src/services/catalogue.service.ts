import { Types } from 'mongoose';
import {
  Category,
  Service,
  Product,
  Vendor,
  Bill,
  Branch,
  Staff,
  ICategory,
  IService,
  IProduct,
  IVendor,
} from '../models';
import { AppError } from '../utils';
import { RequestContext, toObjectId } from './context';
import { auditService } from './audit.service';
import { assertRefsInBusiness } from './tenant-refs';
import { hasPermission } from '../middlewares/permission.middleware';

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Checks every branch, product and staff id a service body points at belongs to this business. */
async function assertServiceRefs(businessId: Types.ObjectId, data: any): Promise<void> {
  await assertRefsInBusiness(Branch, businessId, data.branchPrices?.map((bp: any) => bp.branchId), 'branches');
  await assertRefsInBusiness(Product, businessId, data.consumables?.map((c: any) => c.productId), 'products');
  await assertRefsInBusiness(Staff, businessId, data.eligibleStaffIds, 'staff');
}

export class CatalogueService {
  // --- CATEGORIES ---

  async createCategory(ctx: RequestContext, data: any): Promise<ICategory> {
    if (!hasPermission(ctx, 'manageCatalogue')) {
      throw new AppError(403, 'FORBIDDEN', 'Only the owner (or a manager with catalogue access) can create categories');
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
    if (!hasPermission(ctx, 'manageCatalogue')) {
      throw new AppError(403, 'FORBIDDEN', 'Only the owner (or a manager with catalogue access) can update categories');
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
        // Max two levels: the parent must be top-level and this category must have no children
        if (parent.parentId || (await Category.exists({ businessId, parentId: category._id }))) {
          throw new AppError(400, 'VALIDATION_ERROR', 'Maximum 2 levels of categories allowed');
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
    if (!hasPermission(ctx, 'manageCatalogue')) {
      throw new AppError(403, 'FORBIDDEN', 'Only the owner (or a manager with catalogue access) can reorder categories');
    }
    const businessId = toObjectId(ctx.businessId!);

    for (const item of orders) {
      await Category.updateOne({ _id: toObjectId(item.id), businessId }, { $set: { order: item.order } });
    }
  }

  async getCategories(ctx: RequestContext, active?: boolean): Promise<ICategory[]> {
    const businessId = toObjectId(ctx.businessId!);
    const query: any = { businessId };
    if (active !== undefined) query.active = active;
    return Category.find(query).sort({ order: 1, name: 1 });
  }

  // --- SERVICES ---

  async createService(ctx: RequestContext, data: any): Promise<IService> {
    if (!hasPermission(ctx, 'manageCatalogue')) {
      throw new AppError(403, 'FORBIDDEN', 'Only the owner (or a manager with catalogue access) can create services');
    }

    const businessId = toObjectId(ctx.businessId!);

    const category = await Category.findOne({ _id: toObjectId(data.categoryId), businessId });
    if (!category) {
      throw new AppError(404, 'NOT_FOUND', 'Category not found');
    }
    await assertServiceRefs(businessId, data);

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

    // Manager without manageCatalogue can only update branchPrices for assigned branches
    if (ctx.role === 'manager' && !hasPermission(ctx, 'manageCatalogue')) {
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
    } else if (hasPermission(ctx, 'manageCatalogue')) {
      // Owner (or manager with manageCatalogue) can update everything
      if (updates.categoryId) {
        if (!(await Category.exists({ _id: toObjectId(updates.categoryId), businessId }))) {
          throw new AppError(404, 'NOT_FOUND', 'Category not found');
        }
        service.categoryId = toObjectId(updates.categoryId);
      }
      await assertServiceRefs(businessId, updates);
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
    if (!hasPermission(ctx, 'manageCatalogue')) {
      throw new AppError(403, 'FORBIDDEN', 'Only the owner (or a manager with catalogue access) can deactivate services');
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
    if (filters.search) query.name = { $regex: escapeRegex(filters.search), $options: 'i' };

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

  /**
   * Deactivates a category (soft delete). Blocked while active services or sub-categories use it.
   */
  async deleteCategory(ctx: RequestContext, id: string): Promise<ICategory> {
    const businessId = toObjectId(ctx.businessId!);
    const category = await Category.findOne({ _id: toObjectId(id), businessId });
    if (!category) {
      throw new AppError(404, 'NOT_FOUND', 'Category not found');
    }

    const [services, children] = await Promise.all([
      Service.countDocuments({ businessId, categoryId: category._id, active: true }),
      Category.countDocuments({ businessId, parentId: category._id, active: true }),
    ]);
    if (services > 0 || children > 0) {
      throw new AppError(409, 'CATEGORY_IN_USE', 'Move or deactivate its services and sub-categories first', {
        details: { services, subCategories: children },
      });
    }

    category.active = false;
    await category.save();

    await auditService.logAction({
      ctx,
      action: 'category.deactivate',
      entity: 'category',
      entityId: category._id,
      after: { active: false },
    });

    return category;
  }

  /**
   * Deactivates a service (soft delete); past bills keep referring to it.
   */
  async deleteService(ctx: RequestContext, id: string): Promise<IService> {
    const service = await this.deleteOrDeactivateService(ctx, id);

    await auditService.logAction({
      ctx,
      action: 'service.deactivate',
      entity: 'service',
      entityId: service._id,
      after: { active: false },
    });

    return service;
  }

  /**
   * Sets one branch's price override for a service (pricePaise null = use the base price) and
   * optionally hides the service in that branch. Managers may only change their own branches.
   */
  async setBranchPrice(
    ctx: RequestContext,
    serviceId: string,
    input: { branchId: string; pricePaise?: number | null; active?: boolean }
  ): Promise<IService> {
    const businessId = toObjectId(ctx.businessId!);
    if (ctx.role === 'manager' && !ctx.branchIds.includes(input.branchId)) {
      throw new AppError(403, 'FORBIDDEN', 'Cannot change prices for a branch you do not manage');
    }
    await assertRefsInBusiness(Branch, businessId, [input.branchId], 'branches');

    const service = await Service.findOne({ _id: toObjectId(serviceId), businessId });
    if (!service) {
      throw new AppError(404, 'NOT_FOUND', 'Service not found');
    }

    const idx = service.branchPrices.findIndex((bp) => bp.branchId.toString() === input.branchId);
    const before = idx >= 0 ? { pricePaise: service.branchPrices[idx].pricePaise, active: service.branchPrices[idx].active } : null;
    if (idx >= 0) {
      if (input.pricePaise !== undefined) service.branchPrices[idx].pricePaise = input.pricePaise ?? undefined;
      if (input.active !== undefined) service.branchPrices[idx].active = input.active;
    } else {
      service.branchPrices.push({
        branchId: toObjectId(input.branchId),
        pricePaise: input.pricePaise ?? undefined,
        active: input.active ?? true,
      });
    }
    await service.save();

    await auditService.logAction({
      ctx,
      action: 'service.branch_price_update',
      entity: 'service',
      entityId: service._id,
      branchId: input.branchId,
      before: before ?? undefined,
      after: { pricePaise: input.pricePaise, active: input.active },
    });

    return service;
  }

  /**
   * Bulk price change preview and apply.
   */
  private computeBulkPriceTransition(svc: IService, changeBps: number, branchId?: string) {
    let oldPrice = svc.basePricePaise;
    if (branchId) {
      const bp = svc.branchPrices.find((p) => p.branchId.toString() === branchId);
      if (bp && bp.pricePaise !== undefined && bp.pricePaise !== null) {
        oldPrice = bp.pricePaise;
      }
    }
    const delta = Math.round((oldPrice * changeBps) / 10000);
    const newPrice = Math.max(0, oldPrice + delta);
    return {
      serviceId: svc._id,
      name: svc.name,
      oldPricePaise: oldPrice,
      newPricePaise: newPrice,
      changeBps,
    };
  }

  /**
   * Base prices need catalogue access. One branch's prices may also be changed by a manager with
   * editBranchPrices, for a branch they manage (same rule as PATCH /services/:id/branch-prices).
   */
  private assertBulkPriceAccess(ctx: RequestContext, branchId?: string) {
    const allowed = branchId
      ? hasPermission(ctx, 'manageCatalogue') || hasPermission(ctx, 'editBranchPrices')
      : hasPermission(ctx, 'manageCatalogue');
    if (!allowed) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to change these prices');
    }
    if (branchId && ctx.role === 'manager' && !ctx.branchIds.includes(branchId)) {
      throw new AppError(403, 'FORBIDDEN', 'You can only manage prices for your own branches');
    }
  }

  /** Services of a category and of its sub-categories (FR-SVC-05 "for a category"). */
  private async bulkPriceServices(businessId: Types.ObjectId, categoryId: string) {
    const catId = toObjectId(categoryId);
    const childIds = await Category.find({ businessId, parentId: catId }).distinct('_id');
    return Service.find({ businessId, categoryId: { $in: [catId, ...childIds] } }).sort({ name: 1 });
  }

  async previewBulkPriceChange(
    ctx: RequestContext,
    categoryId: string,
    changeBps: number,
    branchId?: string
  ): Promise<any[]> {
    this.assertBulkPriceAccess(ctx, branchId);
    const businessId = toObjectId(ctx.businessId!);
    const services = await this.bulkPriceServices(businessId, categoryId);
    return services.map((svc) => this.computeBulkPriceTransition(svc, changeBps, branchId));
  }

  async applyBulkPriceChange(
    ctx: RequestContext,
    categoryId: string,
    changeBps: number,
    branchId?: string
  ): Promise<{ updatedCount: number; changes: any[] }> {
    this.assertBulkPriceAccess(ctx, branchId);
    const businessId = toObjectId(ctx.businessId!);
    const services = await this.bulkPriceServices(businessId, categoryId);
    const changes: any[] = [];

    for (const svc of services) {
      const transition = this.computeBulkPriceTransition(svc, changeBps, branchId);
      if (branchId) {
        const bpIdx = svc.branchPrices.findIndex((p) => p.branchId.toString() === branchId);
        if (bpIdx >= 0) {
          svc.branchPrices[bpIdx].pricePaise = transition.newPricePaise;
        } else {
          svc.branchPrices.push({
            branchId: toObjectId(branchId),
            pricePaise: transition.newPricePaise,
            active: true,
          });
        }
      } else {
        svc.basePricePaise = transition.newPricePaise;
      }
      await svc.save();
      changes.push(transition);
    }

    await auditService.logAction({
      ctx,
      action: 'service.bulk_price_change',
      entity: 'service',
      reason: `Bulk price change ${changeBps} bps for category ${categoryId}`,
      after: { categoryId, changeBps, branchId, count: services.length },
    });

    return { updatedCount: services.length, changes };
  }

  // --- PRODUCTS ---

  async createProduct(ctx: RequestContext, data: any): Promise<IProduct> {
    if (!hasPermission(ctx, 'manageCatalogue')) {
      throw new AppError(403, 'FORBIDDEN', 'Only the owner (or a manager with catalogue access) can create products');
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
    if (!hasPermission(ctx, 'manageCatalogue')) {
      throw new AppError(403, 'FORBIDDEN', 'Only the owner (or a manager with catalogue access) can update products');
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
    // The front desk sees selling prices only (purchase price stays with owner and managers)
    return Product.find(query).select(ctx.role === 'branch' ? '-purchasePricePaise' : '').sort({ name: 1 });
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
