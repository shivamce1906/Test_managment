import { Types } from 'mongoose';
import {
  Product,
  StockBalance,
  StockMovement,
  PurchaseOrder,
  Transfer,
  StockAudit,
  Branch,
  Counter,
  Vendor,
  withTransaction,
} from '../models';
import { AppError, ErrorCode, getBusinessDate } from '../utils';
import { RequestContext, toObjectId } from './context';
import { logAction } from './audit.service';
import { assertRefsInBusiness } from './tenant-refs';

/** Managers act only for their assigned branches (owners for all). */
function assertManages(ctx: RequestContext, branchId: Types.ObjectId | string, what: string): void {
  if (ctx.role === 'manager' && !ctx.branchIds.includes(branchId.toString())) {
    throw new AppError(403, ErrorCode.FORBIDDEN, `You do not manage the branch for this ${what}`);
  }
}

/** Which stock pools a product type can live in. */
const POOLS_FOR: Record<string, string[]> = { retail: ['retail'], consumable: ['consumable'], both: ['retail', 'consumable'] };

const unitCost = (product: any) => (product?.purchasePricePaise || 0) / (product?.unitsPerPurchase || 1);
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
  filter?: { pool?: 'retail' | 'consumable'; productId?: string | Types.ObjectId; lowOnly?: boolean }
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);

  const query: any = { businessId, branchId: toObjectId(branchId) };
  if (filter?.pool) query.pool = filter.pool;
  if (filter?.productId) query.productId = toObjectId(filter.productId);

  const balances = await StockBalance.find(query).populate('productId', 'name brand type sku useUnit purchaseUnit unitsPerPurchase reorderLevels purchasePricePaise sellingPricePaise active');
  const rows = balances.map((b: any) => {
    const product = b.productId;
    const reorder = product?.reorderLevels?.find((r: any) => r.branchId.toString() === branchId.toString());
    const reorderLevel = reorder?.qty ?? null;
    return {
      ...b.toObject(),
      reorderLevel,
      low: reorderLevel !== null && b.qty <= reorderLevel,
      valuePaise: Math.round(unitCost(product) * Math.max(0, b.qty)),
    };
  });
  return filter?.lowOnly ? rows.filter((r) => r.low) : rows;
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
    .populate('productId')
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
  if (!POOLS_FOR[product.type]?.includes(input.pool)) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, `${product.name} is a ${product.type} product and has no ${input.pool} stock`, {
      fields: { pool: `Use ${POOLS_FOR[product.type].join(' or ')}` },
    });
  }
  if (input.type === 'internal_use' && input.qty > 0) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Internal use takes stock out: qty must be negative', { fields: { qty: 'Use a negative quantity' } });
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
          costPaise: Math.round(unitCost(product) * Math.abs(input.qty)),
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

  assertManages(ctx, input.branchId, 'purchase order');
  const branch = await Branch.findOne({ _id: toObjectId(input.branchId), businessId });
  if (!branch) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Branch not found');
  }
  await assertRefsInBusiness(Vendor, businessId, [input.vendorId], 'vendors');
  await assertRefsInBusiness(Product, businessId, input.items.map((i) => i.productId), 'products');
  if (new Set(input.items.map((i) => i.productId)).size !== input.items.length) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Each product may appear once on a purchase order');
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

  assertManages(ctx, po.branchId, 'purchase order');
  if (po.status !== 'pending_approval') {
    throw new AppError(422, ErrorCode.INVALID_TRANSITION, `Cannot approve a PO that is ${po.status.replace('_', ' ')}`);
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

  assertManages(ctx, po.branchId, 'purchase order');
  if (po.status !== 'pending_approval') {
    throw new AppError(422, ErrorCode.INVALID_TRANSITION, `Cannot reject a PO that is ${po.status.replace('_', ' ')}`);
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

    assertManages(ctx, po.branchId, 'purchase order');
    if (po.status !== 'approved' && po.status !== 'partly_received') {
      throw new AppError(422, ErrorCode.INVALID_TRANSITION, `A PO that is ${po.status.replace('_', ' ')} cannot receive goods`);
    }

    const businessDate = getBusinessDate();

    for (const receiptItem of input.items) {
      const item = po.items.find((it) => it.productId.toString() === receiptItem.productId.toString());
      if (!item) {
        throw new AppError(422, ErrorCode.VALIDATION_ERROR, `Product ${receiptItem.productId} is not on this PO`);
      }
      const remaining = item.qtyPurchaseUnits - item.receivedPurchaseUnits;
      if (receiptItem.qty > remaining) {
        throw new AppError(422, ErrorCode.VALIDATION_ERROR, `Only ${remaining} purchase unit(s) of this product are still due on the PO`, {
          details: { productId: receiptItem.productId, remaining },
        });
      }

      item.receivedPurchaseUnits += receiptItem.qty;

      const product = await Product.findOne({ _id: toObjectId(receiptItem.productId), businessId }).session(session);
      const unitsPerPurchase = product?.unitsPerPurchase || 1;
      const useUnitsQty = receiptItem.qty * unitsPerPurchase;
      // 'both' products go to the pool named on the receipt (retail by default)
      const targetPool = product?.type === 'consumable' ? 'consumable' : product?.type === 'both' ? receiptItem.pool || 'retail' : 'retail';

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
            // Total cost of this receipt line, rounded once to whole paise
            costPaise: Math.round(item.ratePaise * receiptItem.qty),
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
  assertManages(ctx, po.branchId, 'purchase order');
  if (input.paidPaise > input.amountPaise) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Paid amount cannot be more than the bill amount', { fields: { paidPaise: 'More than the bill' } });
  }

  // Payment status follows the amounts
  po.vendorBill = {
    ...input,
    paymentStatus: input.paidPaise === 0 ? 'unpaid' : input.paidPaise >= input.amountPaise ? 'paid' : 'partly_paid',
  };
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
  filter: { branchId?: string; status?: string; vendorId?: string } = {}
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);

  const query: any = { businessId };
  if (filter.branchId) {
    assertManages(ctx, filter.branchId, 'purchase order');
    query.branchId = toObjectId(filter.branchId);
  } else if (ctx.role === 'manager') {
    query.branchId = { $in: ctx.branchIds.map(toObjectId) };
  }
  if (filter.status) query.status = filter.status;
  if (filter.vendorId) query.vendorId = toObjectId(filter.vendorId);

  return PurchaseOrder.find(query)
    .populate('vendorId', 'name contact phone')
    .populate('branchId', 'name code')
    .sort({ createdAt: -1 });
}

export async function getPurchaseOrderById(ctx: RequestContext, poId: string) {
  const businessId = toObjectId(ctx.businessId!);
  const po = await PurchaseOrder.findOne({ _id: toObjectId(poId), businessId })
    .populate('vendorId', 'name contact phone gstin')
    .populate('branchId', 'name code')
    .populate('items.productId', 'name brand type purchaseUnit useUnit unitsPerPurchase');
  if (!po) throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Purchase order not found');
  assertManages(ctx, (po.branchId as any)._id || po.branchId, 'purchase order');
  return po;
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

  await assertRefsInBusiness(Branch, businessId, [input.fromBranchId, input.toBranchId], 'branches');
  if (ctx.role === 'manager' && !ctx.branchIds.includes(input.fromBranchId) && !ctx.branchIds.includes(input.toBranchId)) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'You manage neither branch of this transfer');
  }
  const products = await Product.find({ businessId, _id: { $in: input.items.map((i) => toObjectId(i.productId)) } });
  for (const it of input.items) {
    const p = products.find((x) => x._id.toString() === it.productId);
    if (!p) throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'One or more products were not found in this business');
    if (!POOLS_FOR[p.type].includes(it.pool)) {
      throw new AppError(422, ErrorCode.VALIDATION_ERROR, `${p.name} has no ${it.pool} stock`);
    }
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

  // The sending branch approves (it is the one giving stock away)
  assertManages(ctx, transfer.fromBranchId, 'transfer (approval is done by the sending branch)');
  if (transfer.status !== 'requested') {
    throw new AppError(422, ErrorCode.INVALID_TRANSITION, `Cannot approve a transfer that is ${transfer.status}`);
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

    assertManages(ctx, transfer.fromBranchId, 'transfer (dispatch is done by the sending branch)');
    if (transfer.status !== 'approved') {
      throw new AppError(422, ErrorCode.INVALID_TRANSITION, `Cannot dispatch a transfer that is ${transfer.status}`);
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
          422,
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
            costPaise: Math.round(unitCost(await Product.findOne({ _id: item.productId, businessId }).session(session)) * item.qty),
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

    assertManages(ctx, transfer.toBranchId, 'transfer (receiving is done by the receiving branch)');
    if (transfer.status !== 'dispatched') {
      throw new AppError(422, ErrorCode.INVALID_TRANSITION, `Cannot receive a transfer that is ${transfer.status}`);
    }

    // Every dispatched line is accounted for once: received in full, or short with a reason
    for (const item of transfer.items) {
      if (!input.items.some((r) => r.productId.toString() === item.productId.toString())) {
        throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Every product on the transfer must be in the receipt (send 0 with a reason if nothing arrived)');
      }
    }

    const businessDate = getBusinessDate();

    for (const recItem of input.items) {
      const item = transfer.items.find((it) => it.productId.toString() === recItem.productId.toString());
      if (!item) {
        throw new AppError(422, ErrorCode.VALIDATION_ERROR, `Product ${recItem.productId} is not on this transfer`);
      }
      if (recItem.receivedQty > item.qty) {
        throw new AppError(422, ErrorCode.VALIDATION_ERROR, `Received more than the ${item.qty} dispatched`, { details: { productId: recItem.productId, dispatched: item.qty } });
      }
      if (recItem.receivedQty < item.qty && !recItem.mismatchReason?.trim()) {
        throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'A short receipt needs a mismatch reason', { fields: { mismatchReason: 'Why fewer arrived' } });
      }

      item.receivedQty = recItem.receivedQty;
      if (recItem.mismatchReason) {
        item.mismatchReason = recItem.mismatchReason;
      }

      if (recItem.receivedQty === 0) continue;

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
  if (ctx.role === 'manager') {
    const mine = ctx.branchIds.map(toObjectId);
    query.$and = [{ $or: [{ fromBranchId: { $in: mine } }, { toBranchId: { $in: mine } }] }];
  }
  if (filter?.status) query.status = filter.status;

  return Transfer.find(query)
    .populate('fromBranchId', 'name code')
    .populate('toBranchId', 'name code')
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

  assertManages(ctx, branchId, 'stock audit');
  const types = input.pool === 'retail' ? ['retail', 'both'] : ['consumable', 'both'];
  const products = await Product.find({ businessId, active: true, type: { $in: types } }).sort({ name: 1 });
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

  assertManages(ctx, audit.branchId, 'stock audit');
  if (audit.status === 'approved') {
    throw new AppError(422, ErrorCode.INVALID_TRANSITION, 'Cannot modify counts of an approved audit');
  }

  const countMap = new Map(input.lines.map((l) => [l.productId.toString(), l.countedQty]));
  const onSheet = new Set(audit.lines.map((l) => l.productId.toString()));
  if ([...countMap.keys()].some((id) => !onSheet.has(id))) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'A counted product is not on this count sheet');
  }

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

    assertManages(ctx, audit.branchId, 'stock audit');
    if (audit.status !== 'submitted') {
      throw new AppError(422, ErrorCode.INVALID_TRANSITION, `Cannot approve an audit that is ${audit.status}`);
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
          // Apply the variance (not an absolute value) so sales after the count still count
          {
            $inc: { qty: delta },
            $set: { lastMovementAt: new Date() },
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
              costPaise: Math.round(unitCost(await Product.findOne({ _id: line.productId, businessId }).session(session)) * Math.abs(delta)),
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
