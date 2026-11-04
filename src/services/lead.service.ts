import { Types } from 'mongoose';
import { Lead, Customer, User, WaConversation } from '../models';
import { AppError, ErrorCode, getBusinessDate, normalizePhone } from '../utils';
import { RequestContext, toObjectId } from './context';
import { logAction } from './audit.service';
import { z } from 'zod';
import { createLeadSchema, leadFollowUpSchema, leadNoteSchema, listLeadsQuerySchema, updateLeadSchema } from '../validations';

/*
 * Leads (PRD §11). Owners see every branch; managers and branch logins only their own branches:
 * another branch's screen is 403, another branch's lead is 404. Branch logins see full phones.
 */

const CLOSED_STAGES = ['booked', 'lost'];

const inScope = (ctx: RequestContext, branchId: Types.ObjectId | string) =>
  ctx.role === 'owner' || ctx.branchIds.includes(branchId.toString());

function assertBranchAccess(ctx: RequestContext, branchId: Types.ObjectId | string) {
  if (!inScope(ctx, branchId)) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'You do not have access to this branch');
  }
}

function requireBusiness(ctx: RequestContext) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  return toObjectId(ctx.businessId);
}

/** Loads a lead of the business; one outside the user's branches is reported as not found. */
async function findScopedLead(ctx: RequestContext, leadId: string | Types.ObjectId) {
  const businessId = requireBusiness(ctx);
  if (!Types.ObjectId.isValid(leadId.toString())) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Lead not found');
  }
  const lead = await Lead.findOne({ _id: toObjectId(leadId), businessId });
  if (!lead || !inScope(ctx, lead.branchId)) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Lead not found');
  }
  return lead;
}

async function assertAssignee(businessId: Types.ObjectId, userId: string) {
  const exists = await User.exists({ _id: toObjectId(userId), businessId });
  if (!exists) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Assigned user not found', { fields: { assignedTo: 'Pick a user of this business' } });
  }
}

/** The lead with everything a detail screen shows: services, assignee, customer, follow-ups and notes with names. */
function loadLeadDetail(businessId: Types.ObjectId, leadId: Types.ObjectId) {
  return Lead.findOne({ _id: leadId, businessId })
    .populate('serviceIds', 'name')
    .populate('assignedTo', 'name role')
    .populate('customerId', 'name phone')
    .populate('followUps.by', 'name')
    .populate('noteLog.by', 'name');
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function createLead(ctx: RequestContext, input: z.infer<typeof createLeadSchema>) {
  const businessId = requireBusiness(ctx);
  assertBranchAccess(ctx, input.branchId);
  if (input.assignedTo) await assertAssignee(businessId, input.assignedTo);

  const userId = toObjectId(ctx.userId);
  const lead = await Lead.create({
    businessId,
    branchId: toObjectId(input.branchId),
    name: input.name,
    phone: normalizePhone(input.phone),
    email: input.email || undefined,
    gender: input.gender,
    dob: input.dob,
    anniversary: input.anniversary,
    address: input.address,
    source: input.source,
    serviceIds: input.serviceIds.map(toObjectId),
    budgetPaise: input.budgetPaise,
    assignedTo: input.assignedTo ? toObjectId(input.assignedTo) : undefined,
    followUpDate: input.followUpDate,
    followUps: [],
    noteLog: input.notes ? [{ text: input.notes, at: new Date(), by: userId }] : [],
    stage: 'new',
    createdBy: userId,
    updatedBy: userId,
  });

  await logAction({
    businessId,
    branchId: toObjectId(input.branchId),
    actorId: userId,
    actorRole: ctx.role,
    action: 'lead.created',
    targetType: 'lead',
    targetId: lead._id,
    after: lead.toObject(),
  });

  return loadLeadDetail(businessId, lead._id);
}

export async function updateLead(
  ctx: RequestContext,
  leadId: string | Types.ObjectId,
  input: z.infer<typeof updateLeadSchema>
) {
  const businessId = requireBusiness(ctx);
  const lead = await findScopedLead(ctx, leadId);

  if (input.stage === 'lost' && !input.lostReason && !lead.lostReason) {
    throw new AppError(400, ErrorCode.BAD_REQUEST, 'Marking a lead Lost requires a reason', { fields: { lostReason: 'Required' } });
  }
  if (input.branchId) assertBranchAccess(ctx, input.branchId);
  if (input.assignedTo) await assertAssignee(businessId, input.assignedTo);

  const before = lead.toObject();

  if (input.branchId) lead.branchId = toObjectId(input.branchId);
  if (input.name !== undefined) lead.name = input.name;
  if (input.phone) lead.phone = normalizePhone(input.phone);
  if (input.email !== undefined) lead.email = input.email || undefined;
  if (input.gender !== undefined) lead.gender = input.gender;
  if (input.dob !== undefined) lead.dob = input.dob;
  if (input.anniversary !== undefined) lead.anniversary = input.anniversary;
  if (input.address !== undefined) lead.address = input.address;
  if (input.source) lead.source = input.source;
  if (input.serviceIds) lead.serviceIds = input.serviceIds.map(toObjectId);
  if (input.budgetPaise !== undefined) lead.budgetPaise = input.budgetPaise;
  if (input.stage) {
    // Reopening a lost lead clears its reason
    if (lead.stage === 'lost' && input.stage !== 'lost' && input.lostReason === undefined) lead.lostReason = undefined;
    lead.stage = input.stage;
  }
  if (input.lostReason !== undefined) lead.lostReason = input.lostReason;
  if (input.assignedTo !== undefined) lead.assignedTo = input.assignedTo ? toObjectId(input.assignedTo) : undefined;
  if (input.followUpDate !== undefined) lead.followUpDate = input.followUpDate ?? undefined;

  (lead as any).updatedBy = toObjectId(ctx.userId);
  await lead.save();

  await logAction({
    businessId,
    branchId: lead.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'lead.updated',
    targetType: 'lead',
    targetId: lead._id,
    before,
    after: lead.toObject(),
  });

  return loadLeadDetail(businessId, lead._id);
}

export async function getLeads(ctx: RequestContext, filter: z.infer<typeof listLeadsQuerySchema> = {}) {
  const businessId = requireBusiness(ctx);
  const query: any = { businessId };

  if (filter.branchId) {
    assertBranchAccess(ctx, filter.branchId);
    query.branchId = toObjectId(filter.branchId);
  } else if (ctx.role !== 'owner') {
    query.branchId = { $in: ctx.branchIds.map(toObjectId) };
  }
  if (filter.stage) query.stage = filter.stage;
  if (filter.source) query.source = filter.source;
  if (filter.assignedTo) query.assignedTo = toObjectId(filter.assignedTo);
  if (filter.followUpDate) query.followUpDate = filter.followUpDate;
  if (filter.due) {
    const today = getBusinessDate();
    query.followUpDate = filter.due === 'today' ? today : { $lt: today };
    query.stage = filter.stage ?? { $nin: CLOSED_STAGES };
  }
  if (filter.search) {
    const text = new RegExp(escapeRegex(filter.search), 'i');
    const digits = filter.search.replace(/\D/g, '');
    query.$or = [{ name: text }, { email: text }, ...(digits.length >= 3 ? [{ phone: new RegExp(digits) }] : [])];
  }

  return Lead.find(query)
    .populate('serviceIds', 'name')
    .populate('assignedTo', 'name role')
    .sort({ createdAt: -1 });
}

export async function getLeadById(ctx: RequestContext, leadId: string | Types.ObjectId) {
  const lead = await findScopedLead(ctx, leadId);
  return loadLeadDetail(lead.businessId, lead._id);
}

/** Records the next numbered follow-up (1st, 2nd …) and sets when the one after is due. */
export async function addLeadFollowUp(
  ctx: RequestContext,
  leadId: string | Types.ObjectId,
  input: z.infer<typeof leadFollowUpSchema>
) {
  const businessId = requireBusiness(ctx);
  const lead = await findScopedLead(ctx, leadId);
  if (lead.stage === 'lost') {
    throw new AppError(409, ErrorCode.INVALID_TRANSITION, 'Reopen this lost lead before adding a follow-up');
  }

  const userId = toObjectId(ctx.userId);
  const at = new Date();
  const number = lead.followUps.length + 1;
  lead.followUps.push({
    number,
    at,
    channel: input.channel,
    outcome: input.outcome,
    note: input.note,
    nextFollowUpDate: input.nextFollowUpDate,
    by: userId,
  } as any);
  if (input.note) lead.noteLog.push({ text: input.note, at, by: userId, followUpNumber: number } as any);
  lead.followUpDate = input.nextFollowUpDate;

  // A first contact moves a new lead on; a positive answer marks it interested
  if (lead.stage === 'new') lead.stage = 'contacted';
  if (input.outcome === 'interested' && ['new', 'contacted'].includes(lead.stage)) lead.stage = 'interested';

  (lead as any).updatedBy = userId;
  await lead.save();

  await logAction({
    businessId,
    branchId: lead.branchId,
    actorId: userId,
    actorRole: ctx.role,
    action: 'lead.follow_up',
    targetType: 'lead',
    targetId: lead._id,
    meta: { number, channel: input.channel, outcome: input.outcome, nextFollowUpDate: input.nextFollowUpDate },
  });

  return loadLeadDetail(businessId, lead._id);
}

export async function addLeadNote(ctx: RequestContext, leadId: string | Types.ObjectId, input: z.infer<typeof leadNoteSchema>) {
  const businessId = requireBusiness(ctx);
  const lead = await findScopedLead(ctx, leadId);
  const userId = toObjectId(ctx.userId);
  lead.noteLog.push({ text: input.text, at: new Date(), by: userId } as any);
  (lead as any).updatedBy = userId;
  await lead.save();

  await logAction({
    businessId,
    branchId: lead.branchId,
    actorId: userId,
    actorRole: ctx.role,
    action: 'lead.note_added',
    targetType: 'lead',
    targetId: lead._id,
  });

  return loadLeadDetail(businessId, lead._id);
}

export async function convertLead(ctx: RequestContext, leadId: string | Types.ObjectId) {
  const businessId = requireBusiness(ctx);
  const lead = await findScopedLead(ctx, leadId);

  if (lead.stage === 'lost') {
    throw new AppError(409, ErrorCode.INVALID_TRANSITION, 'A lost lead cannot be converted');
  }

  if (lead.customerId) {
    const existing = await Customer.findOne({ _id: lead.customerId, businessId });
    if (existing) return existing;
  }

  // An existing customer with this phone is linked, never overwritten
  let customer = await Customer.findOne({ businessId, phone: lead.phone });
  if (!customer) {
    customer = await Customer.create({
      businessId,
      name: lead.name || 'Lead Customer',
      phone: lead.phone,
      email: lead.email,
      gender: lead.gender || 'other',
      dob: lead.dob,
      anniversary: lead.anniversary,
      address: lead.address,
      source: lead.source,
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

  // The lead's WhatsApp chat now shows the customer instead of "Lead"
  await WaConversation.updateMany(
    { businessId, $or: [{ leadId: lead._id }, { phone: lead.phone }], customerId: null },
    { $set: { customerId: customer._id } }
  );

  await logAction({
    businessId,
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
