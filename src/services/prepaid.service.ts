import { Types } from 'mongoose';
import { Plan, CustomerPlan, Customer, WalletLedger, LoyaltyLedger, withTransaction } from '../models';
import { AppError, ErrorCode, getBusinessDate } from '../utils';
import { RequestContext, toObjectId } from './context';
import { logAction } from './audit.service';
import { z } from 'zod';
import {
  createPlanSchema,
  updatePlanSchema,
  extendPlanSchema,
  transferPlanSchema,
  adjustWalletSchema,
} from '../validations';

export async function createPlan(
  ctx: RequestContext,
  input: z.infer<typeof createPlanSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const plan = await Plan.create({
    businessId: toObjectId(ctx.businessId),
    ...input,
    createdBy: toObjectId(ctx.userId),
    updatedBy: toObjectId(ctx.userId),
  });

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: ctx.branchId ? toObjectId(ctx.branchId) : undefined,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'plan.created',
    targetType: 'plan',
    targetId: plan._id,
    after: plan.toObject(),
  });

  return plan;
}

export async function updatePlan(
  ctx: RequestContext,
  planId: string | Types.ObjectId,
  input: z.infer<typeof updatePlanSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const plan = await Plan.findOne({ _id: toObjectId(planId), businessId: toObjectId(ctx.businessId) });
  if (!plan) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Plan not found');
  }

  const before = plan.toObject();

  if (input.name !== undefined) plan.name = input.name;
  if (input.active !== undefined) plan.active = input.active;
  (plan as any).updatedBy = toObjectId(ctx.userId);

  await plan.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: ctx.branchId ? toObjectId(ctx.branchId) : undefined,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'plan.updated',
    targetType: 'plan',
    targetId: plan._id,
    before,
    after: plan.toObject(),
  });

  return plan;
}

export async function getPlans(
  ctx: RequestContext,
  filter?: { type?: string; active?: boolean }
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const query: any = { businessId: toObjectId(ctx.businessId) };
  if (filter?.type) query.type = filter.type;
  if (filter?.active !== undefined) query.active = filter.active;

  return Plan.find(query).sort({ createdAt: -1 });
}

export async function getPlanById(
  ctx: RequestContext,
  planId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const plan = await Plan.findOne({ _id: toObjectId(planId), businessId: toObjectId(ctx.businessId) });
  if (!plan) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Plan not found');
  }
  return plan;
}

// ----------------------------------------------------
// Customer Plans
// ----------------------------------------------------

export async function extendCustomerPlan(
  ctx: RequestContext,
  customerPlanId: string | Types.ObjectId,
  days: number
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const plan = await CustomerPlan.findOne({ _id: toObjectId(customerPlanId), businessId: toObjectId(ctx.businessId) });
  if (!plan) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Customer plan not found');
  }

  if (plan.status === 'cancelled' || plan.status === 'transferred') {
    throw new AppError(400, ErrorCode.INVALID_STATE_TRANSITION, `Cannot extend ${plan.status} plan`);
  }

  const before = plan.toObject();

  const currentTill = new Date(plan.validTill + 'T00:00:00.000Z');
  currentTill.setUTCDate(currentTill.getUTCDate() + days);
  const newValidTill = currentTill.toISOString().slice(0, 10);

  plan.validTill = newValidTill;
  if (plan.status === 'expired') {
    const today = getBusinessDate();
    if (newValidTill >= today) {
      plan.status = 'active';
    }
  }

  plan.log.push({
    action: 'extend',
    at: new Date(),
    by: toObjectId(ctx.userId),
    detail: { days, oldValidTill: before.validTill, newValidTill },
  });
  (plan as any).updatedBy = toObjectId(ctx.userId);

  await plan.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: ctx.branchId ? toObjectId(ctx.branchId) : undefined,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'customer_plan.extended',
    targetType: 'customerPlan',
    targetId: plan._id,
    before,
    after: plan.toObject(),
    meta: { days, newValidTill },
  });

  return plan;
}

export async function freezeCustomerPlan(
  ctx: RequestContext,
  customerPlanId: string | Types.ObjectId,
  reason?: string
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const plan = await CustomerPlan.findOne({ _id: toObjectId(customerPlanId), businessId: toObjectId(ctx.businessId) });
  if (!plan) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Customer plan not found');
  }

  if (plan.status !== 'active') {
    throw new AppError(400, ErrorCode.INVALID_STATE_TRANSITION, 'Only active plans can be frozen');
  }

  const before = plan.toObject();
  plan.status = 'frozen';
  plan.frozenAt = new Date();
  plan.log.push({
    action: 'freeze',
    at: new Date(),
    by: toObjectId(ctx.userId),
  });
  (plan as any).updatedBy = toObjectId(ctx.userId);

  await plan.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: ctx.branchId ? toObjectId(ctx.branchId) : undefined,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'customer_plan.frozen',
    targetType: 'customerPlan',
    targetId: plan._id,
    before,
    after: plan.toObject(),
  });

  return plan;
}

export async function unfreezeCustomerPlan(
  ctx: RequestContext,
  customerPlanId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const plan = await CustomerPlan.findOne({ _id: toObjectId(customerPlanId), businessId: toObjectId(ctx.businessId) });
  if (!plan) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Customer plan not found');
  }

  if (plan.status !== 'frozen') {
    throw new AppError(400, ErrorCode.INVALID_STATE_TRANSITION, 'Only frozen plans can be unfrozen');
  }

  const before = plan.toObject();
  const frozenAt = plan.frozenAt ? plan.frozenAt.getTime() : Date.now();
  const diffDays = Math.max(1, Math.round((Date.now() - frozenAt) / (1000 * 60 * 60 * 24)));

  const currentTill = new Date(plan.validTill + 'T00:00:00.000Z');
  currentTill.setUTCDate(currentTill.getUTCDate() + diffDays);
  const newValidTill = currentTill.toISOString().slice(0, 10);

  plan.status = 'active';
  plan.frozenAt = undefined;
  plan.validTill = newValidTill;
  plan.log.push({
    action: 'unfreeze',
    at: new Date(),
    by: toObjectId(ctx.userId),
    detail: { frozenDaysAdded: diffDays, newValidTill },
  });
  (plan as any).updatedBy = toObjectId(ctx.userId);

  await plan.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: ctx.branchId ? toObjectId(ctx.branchId) : undefined,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'customer_plan.unfrozen',
    targetType: 'customerPlan',
    targetId: plan._id,
    before,
    after: plan.toObject(),
    meta: { frozenDaysAdded: diffDays },
  });

  return plan;
}

export async function transferCustomerPlan(
  ctx: RequestContext,
  customerPlanId: string | Types.ObjectId,
  toCustomerId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const targetCustomer = await Customer.findOne({ _id: toObjectId(toCustomerId), businessId: toObjectId(ctx.businessId) });
  if (!targetCustomer) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Target customer not found');
  }

  const plan = await CustomerPlan.findOne({ _id: toObjectId(customerPlanId), businessId: toObjectId(ctx.businessId) });
  if (!plan) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Customer plan not found');
  }

  if (plan.status !== 'active') {
    throw new AppError(400, ErrorCode.INVALID_STATE_TRANSITION, 'Only active plans can be transferred');
  }

  if (plan.customerId.toString() === toCustomerId.toString()) {
    throw new AppError(400, ErrorCode.BAD_REQUEST, 'Cannot transfer plan to the same customer');
  }

  const before = plan.toObject();
  const oldCustomerId = plan.customerId;

  plan.customerId = toObjectId(toCustomerId);
  plan.log.push({
    action: 'transfer',
    at: new Date(),
    by: toObjectId(ctx.userId),
    detail: { fromCustomerId: oldCustomerId, toCustomerId },
  });
  (plan as any).updatedBy = toObjectId(ctx.userId);

  await plan.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: ctx.branchId ? toObjectId(ctx.branchId) : undefined,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'customer_plan.transferred',
    targetType: 'customerPlan',
    targetId: plan._id,
    before,
    after: plan.toObject(),
    meta: { fromCustomerId: oldCustomerId, toCustomerId },
  });

  return plan;
}

export async function getCustomerPlans(
  ctx: RequestContext,
  customerId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  return CustomerPlan.find({
    businessId: toObjectId(ctx.businessId),
    customerId: toObjectId(customerId),
  }).sort({ createdAt: -1 });
}

export async function getCustomerPlanById(
  ctx: RequestContext,
  id: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const plan = await CustomerPlan.findOne({ _id: toObjectId(id), businessId: toObjectId(ctx.businessId) });
  if (!plan) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Customer plan not found');
  }
  return plan;
}

// ----------------------------------------------------
// Wallet & Loyalty Ledgers
// ----------------------------------------------------

export async function getWalletLedger(
  ctx: RequestContext,
  customerId: string | Types.ObjectId,
  limit = 50,
  skip = 0
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  return WalletLedger.find({
    businessId: toObjectId(ctx.businessId),
    customerId: toObjectId(customerId),
  })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);
}

export async function adjustWallet(
  ctx: RequestContext,
  customerId: string | Types.ObjectId,
  amountPaise: number,
  reason: string
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  if (ctx.role !== 'owner' && ctx.role !== 'super_admin' && ctx.role !== 'superadmin') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Only business owner can adjust wallet balance');
  }

  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  return withTransaction(async (session) => {
    const customer = await Customer.findOne({ _id: toObjectId(customerId), businessId }).session(session);
    if (!customer) {
      throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Customer not found');
    }

    const newBalance = customer.walletBalancePaise + amountPaise;
    if (newBalance < 0) {
      throw new AppError(400, ErrorCode.INSUFFICIENT_WALLET_BALANCE, 'Wallet balance cannot be negative');
    }

    customer.walletBalancePaise = newBalance;
    (customer as any).updatedBy = userId;
    await customer.save({ session });

    const entry = await WalletLedger.create(
      [
        {
          businessId,
          customerId: customer._id,
          branchId: ctx.branchId ? toObjectId(ctx.branchId) : undefined,
          type: 'adjust',
          amountPaise,
          reason,
          balanceAfterPaise: newBalance,
          createdBy: userId,
          updatedBy: userId,
        },
      ],
      { session }
    );

    await logAction({
      businessId,
      branchId: ctx.branchId ? toObjectId(ctx.branchId) : undefined,
      actorId: userId,
      actorRole: ctx.role,
      action: 'wallet.adjusted',
      targetType: 'customer',
      targetId: customer._id,
      meta: { amountPaise, reason, newBalance },
    });

    return entry[0];
  });
}

export async function getLoyaltyLedger(
  ctx: RequestContext,
  customerId: string | Types.ObjectId,
  limit = 50,
  skip = 0
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  return LoyaltyLedger.find({
    businessId: toObjectId(ctx.businessId),
    customerId: toObjectId(customerId),
  })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);
}

export async function lookupVoucher(
  ctx: RequestContext,
  code: string
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const voucher = await CustomerPlan.findOne({
    businessId: toObjectId(ctx.businessId),
    voucherCode: code.toUpperCase().trim(),
  }).populate('customerId');

  if (!voucher) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Voucher not found');
  }

  const today = getBusinessDate();
  if (voucher.validTill < today) {
    throw new AppError(400, ErrorCode.BAD_REQUEST, 'Voucher has expired');
  }
  if (voucher.status !== 'active') {
    throw new AppError(400, ErrorCode.BAD_REQUEST, `Voucher is ${voucher.status}`);
  }

  return voucher;
}
