import { Types } from 'mongoose';
import { Lead, Customer } from '../models';
import { AppError, ErrorCode, normalizePhone, maskPhone } from '../utils';
import { RequestContext, toObjectId } from './context';
import { logAction } from './audit.service';
import { z } from 'zod';
import { createLeadSchema, updateLeadSchema } from '../validations';

export async function createLead(
  ctx: RequestContext,
  input: z.infer<typeof createLeadSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  if (ctx.branchId && String(ctx.branchId) !== String(input.branchId)) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Branch login cannot add a lead to another branch');
  }

  const phone = normalizePhone(input.phone);

  const lead = await Lead.create({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(input.branchId),
    name: input.name,
    phone,
    source: input.source,
    serviceIds: input.serviceIds.map(toObjectId),
    budgetPaise: input.budgetPaise,
    assignedTo: input.assignedTo ? toObjectId(input.assignedTo) : undefined,
    followUpDate: input.followUpDate,
    notes: input.notes,
    stage: 'new',
    createdBy: toObjectId(ctx.userId),
    updatedBy: toObjectId(ctx.userId),
  });

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(input.branchId),
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'lead.created',
    targetType: 'lead',
    targetId: lead._id,
    after: lead.toObject(),
  });

  return lead;
}

export async function updateLead(
  ctx: RequestContext,
  leadId: string | Types.ObjectId,
  input: z.infer<typeof updateLeadSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const lead = await Lead.findOne({ _id: toObjectId(leadId), businessId: toObjectId(ctx.businessId) });
  if (!lead) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Lead not found');
  }

  if (input.stage === 'lost') {
    const reason = input.lostReason || lead.lostReason;
    if (!reason || !reason.trim()) {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'lostReason is required when stage is lost');
    }
  }

  const before = lead.toObject();

  if (input.branchId) lead.branchId = toObjectId(input.branchId);
  if (input.name !== undefined) lead.name = input.name;
  if (input.phone) lead.phone = normalizePhone(input.phone);
  if (input.serviceIds) lead.serviceIds = input.serviceIds.map(toObjectId);
  if (input.budgetPaise !== undefined) lead.budgetPaise = input.budgetPaise;
  if (input.stage) lead.stage = input.stage;
  if (input.lostReason !== undefined) lead.lostReason = input.lostReason;
  if (input.assignedTo !== undefined) lead.assignedTo = input.assignedTo ? toObjectId(input.assignedTo) : undefined;
  if (input.followUpDate !== undefined) lead.followUpDate = input.followUpDate;
  if (input.notes !== undefined) lead.notes = input.notes;

  (lead as any).updatedBy = toObjectId(ctx.userId);
  await lead.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: lead.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'lead.updated',
    targetType: 'lead',
    targetId: lead._id,
    before,
    after: lead.toObject(),
  });

  return lead;
}

export async function getLeads(
  ctx: RequestContext,
  filter?: {
    branchId?: string | Types.ObjectId;
    stage?: string;
    assignedTo?: string | Types.ObjectId;
    followUpDate?: string;
  }
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const query: any = { businessId: toObjectId(ctx.businessId) };
  if (ctx.branchId) {
    query.branchId = toObjectId(ctx.branchId);
  } else if (filter?.branchId) {
    query.branchId = toObjectId(filter.branchId);
  }
  if (filter?.stage) query.stage = filter.stage;
  if (filter?.assignedTo) query.assignedTo = toObjectId(filter.assignedTo);
  if (filter?.followUpDate) query.followUpDate = filter.followUpDate;

  const leads = await Lead.find(query).populate('serviceIds', 'name').sort({ createdAt: -1 });
  if (ctx.role === 'branch') {
    return leads.map((l) => {
      const obj = l.toObject();
      obj.phone = maskPhone(obj.phone);
      return obj;
    });
  }
  return leads;
}

export async function getLeadById(
  ctx: RequestContext,
  leadId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const lead = await Lead.findOne({ _id: toObjectId(leadId), businessId: toObjectId(ctx.businessId) })
    .populate('serviceIds', 'name')
    .populate('customerId');

  if (!lead) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Lead not found');
  }
  return lead;
}

export async function convertLead(
  ctx: RequestContext,
  leadId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const lead = await Lead.findOne({ _id: toObjectId(leadId), businessId: toObjectId(ctx.businessId) });
  if (!lead) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Lead not found');
  }

  if (lead.stage === 'lost') {
    throw new AppError(422, ErrorCode.INVALID_TRANSITION, 'A lost lead cannot be converted');
  }

  if (lead.customerId) {
    const existing = await Customer.findOne({ _id: lead.customerId, businessId: toObjectId(ctx.businessId) });
    if (existing) return existing;
  }

  let customer = await Customer.findOne({ businessId: toObjectId(ctx.businessId), phone: lead.phone });
  if (!customer) {
    customer = await Customer.create({
      businessId: toObjectId(ctx.businessId),
      name: lead.name || 'Lead Customer',
      phone: lead.phone,
      gender: 'other',
      tags: ['lead_converted'],
      consent: { marketing: true, transactional: true },
      createdBy: toObjectId(ctx.userId),
      updatedBy: toObjectId(ctx.userId),
    });
  }

  lead.customerId = customer._id;
  lead.stage = 'booked';
  (lead as any).updatedBy = toObjectId(ctx.userId);
  await lead.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: lead.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'lead.converted',
    targetType: 'lead',
    targetId: lead._id,
    meta: { customerId: customer._id },
  });

  return customer;
}
