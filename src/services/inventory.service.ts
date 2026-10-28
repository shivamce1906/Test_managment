import { Types } from 'mongoose';
import {
  Product,
  StockBalance,
  StockMovement,
  PurchaseOrder,
  Transfer,
  StockAudit,
  Branch,
  Vendor,
  Counter,
  withTransaction,
} from '../models';
import { AppError, ErrorCode, getBusinessDate } from '../utils';
import { RequestContext, toObjectId } from './context';
import { logAction } from './audit.service';
import { z } from 'zod';
import {
  stockAdjustmentSchema,
  createPurchaseOrderSchema,
  receivePurchaseOrderSchema,
  vendorBillSchema,
  createTransferSchema,
  receiveTransferSchema,
  createStockAuditSchema,
  updateStockAuditCountsSchema,
} from '../validations';

// ----------------------------------------------------
// Stock Balances & Movements
// ----------------------------------------------------

export async function getStockBalances(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  filter?: { pool?: 'retail' | 'consumable'; productId?: string | Types.ObjectId }
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);

  const query: any = { businessId, branchId: toObjectId(branchId) };
  if (filter?.pool) query.pool = filter.pool;
  if (filter?.productId) query.productId = toObjectId(filter.productId);

  return StockBalance.find(query).populate({ path: 'productId', options: { skipTenantScope: true } });
}

export async function getStockMovements(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  filter?: {
    productId?: string | Types.ObjectId;
    pool?: 'retail' | 'consumable';
    type?: string;
    businessDate?: string;
    limit?: number;
    skip?: number;
  }
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);

  const query: any = { businessId, branchId: toObjectId(branchId) };
  if (filter?.productId) query.productId = toObjectId(filter.productId);
  if (filter?.pool) query.pool = filter.pool;
  if (filter?.type) query.type = filter.type;
  if (filter?.businessDate) query.businessDate = filter.businessDate;

  return StockMovement.find(query)
    .populate({ path: 'productId', options: { skipTenantScope: true } })
    .sort({ createdAt: -1 })
    .skip(filter?.skip || 0)
    .limit(filter?.limit || 50);
}

export async function adjustStock(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  input: z.infer<typeof stockAdjustmentSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  const product = await Product.findOne({ _id: toObjectId(input.productId), businessId });
  if (!product) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Product not found');
  }

  if (product.type === 'retail' && input.pool === 'consumable') {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Retail-only products cannot be stocked or adjusted in the consumable pool');
  }
  if (product.type === 'consumable' && input.pool === 'retail') {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Consumable-only products cannot be stocked or adjusted in the retail pool');
  }

  return withTransaction(async (session) => {
    const balance = await StockBalance.findOneAndUpdate(
      {
        businessId,
        branchId: toObjectId(branchId),
        productId: toObjectId(input.productId),
        pool: input.pool,
      },
      {
        $inc: { qty: input.qty },
        $set: { lastMovementAt: new Date() },
      },
      { upsert: true, new: true, session }
    );

    const movement = await StockMovement.create(
      [
        {
          businessId,
          branchId: toObjectId(branchId),
          productId: toObjectId(input.productId),
          pool: input.pool,
          type: input.type,
          qty: input.qty,
          costPaise: 0,
          reason: input.reason,
          businessDate: getBusinessDate(),
          createdBy: userId,
          updatedBy: userId,
        },
      ],
      { session }
    );

    await logAction({
      businessId,
      branchId: toObjectId(branchId),
      actorId: userId,
      actorRole: ctx.role,
      action: 'stock.adjusted',
      targetType: 'product',
      targetId: product._id,
      meta: { pool: input.pool, qtyDelta: input.qty, newQty: balance.qty, reason: input.reason },
    });

    return { balance, movement: movement[0] };
  });
}

// ----------------------------------------------------
// Purchase Orders
// ----------------------------------------------------

export async function createPurchaseOrder(
  ctx: RequestContext,
  input: z.infer<typeof createPurchaseOrderSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  if (ctx.role === 'manager') {
    const manages = (ctx.branchIds || []).includes(input.branchId.toString());
    if (!manages) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'Manager does not have access to this branch');
    }
  }

  const branch = await Branch.findOne({ _id: toObjectId(input.branchId), businessId });
  if (!branch) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Branch not found');
  }

  const vendor = await Vendor.findOne({ _id: toObjectId(input.vendorId), businessId });
  if (!vendor) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Vendor not found or does not belong to this business');
  }

  const productIds = input.items.map((it) => toObjectId(it.productId));
  const products = await Product.find({ _id: { $in: productIds }, businessId });
  if (products.length !== productIds.length) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'One or more products do not belong to this business');
  }

  return withTransaction(async (session) => {
    const counter = await Counter.findOneAndUpdate(
      { _id: `${ctx.businessId}:${input.branchId}:po:global` },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, session }
    );

    const poNo = `PO-${branch.code.toUpperCase()}-${String(counter.seq).padStart(4, '0')}`;

    let totalPaise = 0;
    const poItems = input.items.map((it) => {
      const lineTotal = it.qtyPurchaseUnits * it.ratePaise;
      totalPaise += lineTotal;
      return {
        productId: toObjectId(it.productId),
        qtyPurchaseUnits: it.qtyPurchaseUnits,
        ratePaise: it.ratePaise,
        receivedPurchaseUnits: 0,
      };
    });

    const po = await PurchaseOrder.create(
      [
        {
          businessId,
          branchId: toObjectId(input.branchId),
          vendorId: toObjectId(input.vendorId),
          poNo,
          items: poItems,
          totalPaise,
          status: 'pending_approval',
          approvals: [],
          receipts: [],
          createdBy: userId,
          updatedBy: userId,
        },
      ],
      { session }
    );

    await logAction({
      businessId,
      branchId: branch._id,
      actorId: userId,
      actorRole: ctx.role,
      action: 'purchase_order.created',
      targetType: 'purchaseOrder',
      targetId: po[0]._id,
      after: po[0].toObject(),
    });

    return po[0];
  });
}

export async function approvePurchaseOrder(
  ctx: RequestContext,
  poId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  const po = await PurchaseOrder.findOne({ _id: toObjectId(poId), businessId });
  if (!po) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Purchase order not found');
  }

  if (po.status !== 'pending_approval') {
    throw new AppError(400, ErrorCode.BAD_REQUEST, `Cannot approve PO in ${po.status} status`);
  }

  po.status = 'approved';
  po.approvals.push({
    action: 'approved',
    by: userId,
    at: new Date(),
  });
  (po as any).updatedBy = userId;
  await po.save();

  await logAction({
    businessId,
    branchId: po.branchId,
    actorId: userId,
    actorRole: ctx.role,
    action: 'purchase_order.approved',
    targetType: 'purchaseOrder',
    targetId: po._id,
  });

  return po;
}

export async function rejectPurchaseOrder(
  ctx: RequestContext,
  poId: string | Types.ObjectId,
  reason: string
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  const po = await PurchaseOrder.findOne({ _id: toObjectId(poId), businessId });
  if (!po) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Purchase order not found');
  }

  if (po.status !== 'pending_approval') {
    throw new AppError(400, ErrorCode.BAD_REQUEST, `Cannot reject PO in ${po.status} status`);
  }

  po.status = 'rejected';
  po.approvals.push({
    action: 'rejected',
    by: userId,
    at: new Date(),
    reason,
  });
  (po as any).updatedBy = userId;
  await po.save();

  await logAction({
    businessId,
    branchId: po.branchId,
    actorId: userId,
    actorRole: ctx.role,
    action: 'purchase_order.rejected',
    targetType: 'purchaseOrder',
    targetId: po._id,
    meta: { reason },
  });

  return po;
}

export async function receivePurchaseOrder(
  ctx: RequestContext,
  poId: string | Types.ObjectId,
  input: z.infer<typeof receivePurchaseOrderSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  return withTransaction(async (session) => {
    const po = await PurchaseOrder.findOne({ _id: toObjectId(poId), businessId }).session(session);
    if (!po) {
      throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Purchase order not found');
    }

    if (po.status !== 'approved' && po.status !== 'partly_received') {
      throw new AppError(400, ErrorCode.BAD_REQUEST, `PO cannot receive goods in ${po.status} status`);
    }

    const businessDate = getBusinessDate();

    for (const receiptItem of input.items) {
      const item = po.items.find((it) => it.productId.toString() === receiptItem.productId.toString());
      if (!item) {
        throw new AppError(400, ErrorCode.BAD_REQUEST, `Product ${receiptItem.productId} not found in this PO`);
      }

      if (item.receivedPurchaseUnits + receiptItem.qty > item.qtyPurchaseUnits) {
        throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Cannot receive more than ordered');
      }

      item.receivedPurchaseUnits += receiptItem.qty;

      const product = await Product.findOne({ _id: toObjectId(receiptItem.productId), businessId }).session(session);
      const unitsPerPurchase = product?.unitsPerPurchase || 1;
      const useUnitsQty = receiptItem.qty * unitsPerPurchase;
      const targetPool = product?.type === 'retail' ? 'retail' : 'consumable';

      await StockBalance.findOneAndUpdate(
        {
          businessId,
          branchId: po.branchId,
          productId: toObjectId(receiptItem.productId),
          pool: targetPool,
        },
        {
          $inc: { qty: useUnitsQty },
          $set: { lastMovementAt: new Date() },
        },
        { upsert: true, session }
      );

      await StockMovement.create(
        [
          {
            businessId,
            branchId: po.branchId,
            productId: toObjectId(receiptItem.productId),
            pool: targetPool,
            type: 'purchase',
            qty: useUnitsQty,
            costPaise: Math.round(receiptItem.qty * item.ratePaise),
            refType: 'purchaseOrder',
            refId: po._id,
            batch: receiptItem.batch,
            expiry: receiptItem.expiry,
            businessDate,
            createdBy: userId,
            updatedBy: userId,
          },
        ],
        { session }
      );
    }

    const allReceived = po.items.every((it) => it.receivedPurchaseUnits >= it.qtyPurchaseUnits);
    po.status = allReceived ? 'received' : 'partly_received';

    po.receipts.push({
      at: new Date(),
      by: userId,
      items: input.items.map((i) => ({
        productId: toObjectId(i.productId),
        qty: i.qty,
        batch: i.batch,
        expiry: i.expiry,
      })),
    });

    (po as any).updatedBy = userId;
    await po.save({ session });

    await logAction({
      businessId,
      branchId: po.branchId,
      actorId: userId,
      actorRole: ctx.role,
      action: 'purchase_order.received',
      targetType: 'purchaseOrder',
      targetId: po._id,
      meta: { status: po.status, itemsCount: input.items.length },
    });

    return po;
  });
}

export async function recordVendorBill(
  ctx: RequestContext,
  poId: string | Types.ObjectId,
  input: z.infer<typeof vendorBillSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  const po = await PurchaseOrder.findOne({ _id: toObjectId(poId), businessId });
  if (!po) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Purchase order not found');
  }

  po.vendorBill = input;
  (po as any).updatedBy = userId;
  await po.save();

  await logAction({
    businessId,
    branchId: po.branchId,
    actorId: userId,
    actorRole: ctx.role,
    action: 'purchase_order.vendor_bill_recorded',
    targetType: 'purchaseOrder',
    targetId: po._id,
    meta: input,
  });

  return po;
}

export async function getPurchaseOrders(
  ctx: RequestContext,
  branchId?: string | Types.ObjectId,
  status?: string
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);

  const query: any = { businessId };
  if (branchId) query.branchId = toObjectId(branchId);
  if (status) query.status = status;

  return PurchaseOrder.find(query)
    .populate({ path: 'vendorId', select: 'name contactPerson phone', options: { skipTenantScope: true } })
    .sort({ createdAt: -1 });
}

// ----------------------------------------------------
// Inter-branch Transfers
// ----------------------------------------------------

export async function createTransfer(
  ctx: RequestContext,
  input: z.infer<typeof createTransferSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  const fromBranch = await Branch.findOne({ _id: toObjectId(input.fromBranchId), businessId });
  const toBranch = await Branch.findOne({ _id: toObjectId(input.toBranchId), businessId });
  if (!fromBranch || !toBranch) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'From or To branch not found or does not belong to this business');
  }

  return withTransaction(async (session) => {
    const counter = await Counter.findOneAndUpdate(
      { _id: `${ctx.businessId}:transfers:global` },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, session }
    );

    const transferNo = `TR-${String(counter.seq).padStart(4, '0')}`;

    const transfer = await Transfer.create(
      [
        {
          businessId,
          transferNo,
          fromBranchId: toObjectId(input.fromBranchId),
          toBranchId: toObjectId(input.toBranchId),
          items: input.items.map((it) => ({
            productId: toObjectId(it.productId),
            pool: it.pool,
            qty: it.qty,
          })),
          status: 'requested',
          log: [
            {
              action: 'requested',
              by: userId,
              at: new Date(),
            },
          ],
          createdBy: userId,
          updatedBy: userId,
        },
      ],
      { session }
    );

    await logAction({
      businessId,
      branchId: toObjectId(input.fromBranchId),
      actorId: userId,
      actorRole: ctx.role,
      action: 'transfer.requested',
      targetType: 'transfer',
      targetId: transfer[0]._id,
      after: transfer[0].toObject(),
    });

    return transfer[0];
  });
}

export async function approveTransfer(
  ctx: RequestContext,
  transferId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  const transfer = await Transfer.findOne({ _id: toObjectId(transferId), businessId });
  if (!transfer) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Transfer not found');
  }

  if (transfer.status !== 'requested') {
    throw new AppError(400, ErrorCode.BAD_REQUEST, `Cannot approve transfer in ${transfer.status} status`);
  }

  if (ctx.role === 'manager') {
    const managesFrom = (ctx.branchIds || []).includes(transfer.fromBranchId.toString());
    if (!managesFrom) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'Only managers of the sending branch can approve transfers');
    }
  }

  transfer.status = 'approved';
  transfer.log.push({
    action: 'approved',
    by: userId,
    at: new Date(),
  });
  (transfer as any).updatedBy = userId;
  await transfer.save();

  await logAction({
    businessId,
    branchId: transfer.fromBranchId,
    actorId: userId,
    actorRole: ctx.role,
    action: 'transfer.approved',
    targetType: 'transfer',
    targetId: transfer._id,
  });

  return transfer;
}

export async function dispatchTransfer(
  ctx: RequestContext,
  transferId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  return withTransaction(async (session) => {
    const transfer = await Transfer.findOne({ _id: toObjectId(transferId), businessId }).session(session);
    if (!transfer) {
      throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Transfer not found');
    }

    if (transfer.status !== 'approved') {
      throw new AppError(400, ErrorCode.BAD_REQUEST, `Cannot dispatch transfer in ${transfer.status} status`);
    }

    const businessDate = getBusinessDate();

    for (const item of transfer.items) {
      const balance = await StockBalance.findOne({
        businessId,
        branchId: transfer.fromBranchId,
        productId: item.productId,
        pool: item.pool,
      }).session(session);

      if (!balance || balance.qty < item.qty) {
        throw new AppError(
          400,
          ErrorCode.INSUFFICIENT_STOCK,
          `Insufficient stock in source branch for product ${item.productId}`
        );
      }

      balance.qty -= item.qty;
      balance.lastMovementAt = new Date();
      await balance.save({ session });

      await StockMovement.create(
        [
          {
            businessId,
            branchId: transfer.fromBranchId,
            productId: item.productId,
            pool: item.pool,
            type: 'transfer_out',
            qty: -item.qty,
            refType: 'transfer',
            refId: transfer._id,
            businessDate,
            createdBy: userId,
            updatedBy: userId,
          },
        ],
        { session }
      );
    }

    transfer.status = 'dispatched';
    transfer.log.push({
      action: 'dispatched',
      by: userId,
      at: new Date(),
    });
    (transfer as any).updatedBy = userId;
    await transfer.save({ session });

    await logAction({
      businessId,
      branchId: transfer.fromBranchId,
      actorId: userId,
      actorRole: ctx.role,
      action: 'transfer.dispatched',
      targetType: 'transfer',
      targetId: transfer._id,
    });

    return transfer;
  });
}

export async function receiveTransfer(
  ctx: RequestContext,
  transferId: string | Types.ObjectId,
  input: z.infer<typeof receiveTransferSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  return withTransaction(async (session) => {
    const transfer = await Transfer.findOne({ _id: toObjectId(transferId), businessId }).session(session);
    if (!transfer) {
      throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Transfer not found');
    }

    if (transfer.status !== 'dispatched') {
      throw new AppError(400, ErrorCode.BAD_REQUEST, `Cannot receive transfer in ${transfer.status} status`);
    }

    const businessDate = getBusinessDate();

    for (const recItem of input.items) {
      const item = transfer.items.find((it) => it.productId.toString() === recItem.productId.toString());
      if (!item) {
        throw new AppError(400, ErrorCode.BAD_REQUEST, `Product ${recItem.productId} not found in this transfer`);
      }

      if (recItem.receivedQty > item.qty) {
        throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Cannot receive more than dispatched quantity');
      }
      if (recItem.receivedQty < item.qty && !recItem.mismatchReason) {
        throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Mismatch reason is required when received quantity is less than dispatched');
      }

      item.receivedQty = recItem.receivedQty;
      if (recItem.mismatchReason) {
        item.mismatchReason = recItem.mismatchReason;
      }

      await StockBalance.findOneAndUpdate(
        {
          businessId,
          branchId: transfer.toBranchId,
          productId: item.productId,
          pool: item.pool,
        },
        {
          $inc: { qty: recItem.receivedQty },
          $set: { lastMovementAt: new Date() },
        },
        { upsert: true, session }
      );

      await StockMovement.create(
        [
          {
            businessId,
            branchId: transfer.toBranchId,
            productId: item.productId,
            pool: item.pool,
            type: 'transfer_in',
            qty: recItem.receivedQty,
            refType: 'transfer',
            refId: transfer._id,
            reason: recItem.mismatchReason,
            businessDate,
            createdBy: userId,
            updatedBy: userId,
          },
        ],
        { session }
      );
    }

    transfer.status = 'received';
    transfer.log.push({
      action: 'received',
      by: userId,
      at: new Date(),
    });
    (transfer as any).updatedBy = userId;
    await transfer.save({ session });

    await logAction({
      businessId,
      branchId: transfer.toBranchId,
      actorId: userId,
      actorRole: ctx.role,
      action: 'transfer.received',
      targetType: 'transfer',
      targetId: transfer._id,
    });

    return transfer;
  });
}

export async function getTransfers(
  ctx: RequestContext,
  filter?: { branchId?: string | Types.ObjectId; status?: string }
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);

  const query: any = { businessId };
  if (filter?.branchId) {
    const bId = toObjectId(filter.branchId);
    query.$or = [{ fromBranchId: bId }, { toBranchId: bId }];
  }
  if (filter?.status) query.status = filter.status;

  return Transfer.find(query)
    .populate({ path: 'fromBranchId', select: 'name code', options: { skipTenantScope: true } })
    .populate({ path: 'toBranchId', select: 'name code', options: { skipTenantScope: true } })
    .sort({ createdAt: -1 });
}

// ----------------------------------------------------
// Stock Audits
// ----------------------------------------------------

export async function createStockAudit(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  input: z.infer<typeof createStockAuditSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  const products = await Product.find({ businessId, active: true });
  const balances = await StockBalance.find({
    businessId,
    branchId: toObjectId(branchId),
    pool: input.pool,
  });

  const balanceMap = new Map(balances.map((b) => [b.productId.toString(), b.qty]));

  const lines = products.map((prod) => ({
    productId: prod._id,
    systemQty: balanceMap.get(prod._id.toString()) || 0,
    countedQty: undefined,
  }));

  const audit = await StockAudit.create({
    businessId,
    branchId: toObjectId(branchId),
    pool: input.pool,
    status: 'counting',
    lines,
    createdBy: userId,
    updatedBy: userId,
  });

  await logAction({
    businessId,
    branchId: toObjectId(branchId),
    actorId: userId,
    actorRole: ctx.role,
    action: 'stock_audit.created',
    targetType: 'stockAudit',
    targetId: audit._id,
    meta: { pool: input.pool, linesCount: lines.length },
  });

  return audit;
}

export async function updateStockAuditCounts(
  ctx: RequestContext,
  auditId: string | Types.ObjectId,
  input: z.infer<typeof updateStockAuditCountsSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  const audit = await StockAudit.findOne({ _id: toObjectId(auditId), businessId });
  if (!audit) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Stock audit not found');
  }

  if (audit.status === 'approved') {
    throw new AppError(400, ErrorCode.BAD_REQUEST, 'Cannot modify counts of an approved audit');
  }

  const countMap = new Map(input.lines.map((l) => [l.productId.toString(), l.countedQty]));

  for (const line of audit.lines) {
    if (countMap.has(line.productId.toString())) {
      line.countedQty = countMap.get(line.productId.toString());
    }
  }

  audit.status = 'submitted';
  (audit as any).updatedBy = userId;
  await audit.save();

  await logAction({
    businessId,
    branchId: audit.branchId,
    actorId: userId,
    actorRole: ctx.role,
    action: 'stock_audit.counts_submitted',
    targetType: 'stockAudit',
    targetId: audit._id,
  });

  return audit;
}

export async function approveStockAudit(
  ctx: RequestContext,
  auditId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  return withTransaction(async (session) => {
    const audit = await StockAudit.findOne({ _id: toObjectId(auditId), businessId }).session(session);
    if (!audit) {
      throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Stock audit not found');
    }

    if (audit.status === 'approved') {
      return audit;
    }

    if (audit.status !== 'submitted') {
      throw new AppError(400, ErrorCode.BAD_REQUEST, `Cannot approve audit in ${audit.status} status`);
    }

    const businessDate = getBusinessDate();

    for (const line of audit.lines) {
      if (line.countedQty !== undefined && line.countedQty !== line.systemQty) {
        const delta = line.countedQty - line.systemQty;

        await StockBalance.findOneAndUpdate(
          {
            businessId,
            branchId: audit.branchId,
            productId: line.productId,
            pool: audit.pool,
          },
          {
            $set: { qty: line.countedQty, lastMovementAt: new Date() },
          },
          { upsert: true, session }
        );

        await StockMovement.create(
          [
            {
              businessId,
              branchId: audit.branchId,
              productId: line.productId,
              pool: audit.pool,
              type: 'audit',
              qty: delta,
              refType: 'stockAudit',
              refId: audit._id,
              reason: 'Audit discrepancy correction',
              businessDate,
              createdBy: userId,
              updatedBy: userId,
            },
          ],
          { session }
        );
      }
    }

    audit.status = 'approved';
    (audit as any).updatedBy = userId;
    await audit.save({ session });

    await logAction({
      businessId,
      branchId: audit.branchId,
      actorId: userId,
      actorRole: ctx.role,
      action: 'stock_audit.approved',
      targetType: 'stockAudit',
      targetId: audit._id,
    });

    return audit;
  });
}

export async function getStockAudits(
  ctx: RequestContext,
  branchId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);

  return StockAudit.find({ businessId, branchId: toObjectId(branchId) }).sort({ createdAt: -1 });
}
