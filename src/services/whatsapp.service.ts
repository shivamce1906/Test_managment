import { Types } from 'mongoose';
import {
  WaNumber,
  WaConversation,
  WaMessage,
  WaTemplate,
  Campaign,
  Automation,
  Feedback,
  Customer,
  Bill,
  withTransaction,
} from '../models';
import { AppError, ErrorCode, normalizePhone, encrypt, decrypt } from '../utils';
import { RequestContext, toObjectId } from './context';
import { logAction } from './audit.service';
import { sendAiSensyMessage, fetchAiSensyTemplates, getRedisClient } from '../integrations';
import { z } from 'zod';
import {
  configureWaNumberSchema,
  sendWaMessageSchema,
  createCampaignSchema,
  updateAutomationSchema,
  submitFeedbackSchema,
} from '../validations';
import { env } from '../config';

const ENCRYPTION_SECRET = env.ENCRYPTION_SECRET;

// ----------------------------------------------------
// Numbers & Templates
// ----------------------------------------------------

export async function configureWaNumber(
  ctx: RequestContext,
  input: z.infer<typeof configureWaNumberSchema>,
  businessIdOverride?: string | Types.ObjectId
) {
  const businessId = businessIdOverride ? toObjectId(businessIdOverride) : ctx.businessId ? toObjectId(ctx.businessId) : undefined;
  if (!businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const phone = normalizePhone(input.phone);
  const apiKeyEnc = encrypt(input.apiKey);
  const webhookSecretEnc = encrypt(input.webhookSecret || 'secret');

  const waNum = await WaNumber.findOneAndUpdate(
    { businessId, phone },
    {
      businessId,
      phone,
      aisensy: {
        apiKeyEnc,
        projectId: input.projectId,
        webhookSecretEnc,
      },
      branchIds: input.branchIds ? input.branchIds.map((id) => new Types.ObjectId(id)) : [],
      status: 'active',
      lowBalance: false,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    },
    { upsert: true, new: true }
  );

  await logAction({
    businessId: ctx.businessId,
    branchId: ctx.branchId,
    actorId: ctx.userId,
    actorRole: ctx.role,
    action: 'wa_number.configured',
    targetType: 'waNumber',
    targetId: waNum._id,
    meta: { phone },
  });

  // Automatically fetch & sync templates
  await syncWaTemplates(ctx, waNum._id);

  return waNum;
}

export async function getWaNumbers(ctx: RequestContext) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const numbers = await WaNumber.find({ businessId: ctx.businessId });
  return numbers.map((n) => ({
    _id: n._id,
    phone: n.phone,
    projectId: n.aisensy.projectId,
    status: n.status,
    lowBalance: n.lowBalance,
    branchIds: n.branchIds,
    createdAt: n.createdAt,
  }));
}

export async function syncWaTemplates(
  ctx: RequestContext,
  numberId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const waNum = await WaNumber.findOne({ _id: numberId, businessId: ctx.businessId });
  if (!waNum) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'WhatsApp number not found');
  }

  const apiKey = decrypt(waNum.aisensy.apiKeyEnc);
  const externalTemplates = await fetchAiSensyTemplates(apiKey);

  const synced = [];
  for (const t of externalTemplates) {
    const doc = await WaTemplate.findOneAndUpdate(
      {
        businessId: ctx.businessId,
        numberId: waNum._id,
        name: t.name,
      },
      {
        businessId: ctx.businessId,
        numberId: waNum._id,
        name: t.name,
        language: t.language || 'en',
        category: t.category || 'utility',
        body: t.body,
        variables: t.variables || [],
        status: t.status === 'APPROVED' ? 'approved' : 'pending',
        syncedAt: new Date(),
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
      { upsert: true, new: true }
    );
    synced.push(doc);
  }

  return synced;
}

export async function getWaTemplates(
  ctx: RequestContext,
  numberId?: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const query: any = { businessId: ctx.businessId };
  if (numberId) query.numberId = numberId;

  return WaTemplate.find(query).sort({ name: 1 });
}

// ----------------------------------------------------
// Conversations & Messages
// ----------------------------------------------------

export async function getConversations(
  ctx: RequestContext,
  branchId?: string | Types.ObjectId,
  filter?: { unreadOnly?: boolean; search?: string }
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const query: any = { businessId: ctx.businessId };
  if (branchId) query.branchId = branchId;
  if (filter?.unreadOnly) query.unread = { $gt: 0 };
  if (filter?.search) {
    query.phone = { $regex: filter.search, $options: 'i' };
  }

  return WaConversation.find(query)
    .populate('customerId', 'name phone')
    .populate('leadId', 'name phone stage')
    .sort({ lastMessageAt: -1 });
}

export async function getConversationById(
  ctx: RequestContext,
  conversationId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const conv = await WaConversation.findOne({ _id: conversationId, businessId: ctx.businessId })
    .populate('customerId')
    .populate('leadId');

  if (!conv) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Conversation not found');
  }

  return conv;
}

export async function getMessages(
  ctx: RequestContext,
  conversationId: string | Types.ObjectId,
  limit = 50,
  skip = 0
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  // Clear unread count on reading
  await WaConversation.findOneAndUpdate(
    { _id: conversationId, businessId: ctx.businessId },
    { $set: { unread: 0 } }
  );

  return WaMessage.find({
    businessId: ctx.businessId,
    conversationId,
  })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);
}

export async function sendMessage(
  ctx: RequestContext,
  conversationId: string | Types.ObjectId,
  input: z.infer<typeof sendWaMessageSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const conv = await WaConversation.findOne({ _id: conversationId, businessId: ctx.businessId });
  if (!conv) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Conversation not found');
  }

  // 24-hour window check for free-form text
  if (input.text && !input.templateId) {
    const lastInbound = conv.lastInboundAt ? conv.lastInboundAt.getTime() : 0;
    const windowElapsedMs = Date.now() - lastInbound;
    if (windowElapsedMs > 24 * 60 * 60 * 1000) {
      throw new AppError(
        400,
        ErrorCode.WA_WINDOW_CLOSED,
        'Cannot send free-form message outside 24-hour customer response window. Use an approved template.'
      );
    }
  }

  const waNum = await WaNumber.findOne({ _id: conv.numberId, businessId: ctx.businessId });
  if (!waNum) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'WhatsApp configuration not found');
  }

  const apiKey = decrypt(waNum.aisensy.apiKeyEnc);

  let templateName: string | undefined;
  if (input.templateId) {
    const tmpl = await WaTemplate.findOne({ _id: input.templateId, businessId: ctx.businessId });
    if (!tmpl) {
      throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Template not found');
    }
    templateName = tmpl.name;
  }

  const sendResult = await sendAiSensyMessage({
    apiKey,
    campaignName: templateName || 'direct_message',
    destination: conv.phone,
    userName: 'Customer',
    templateParams: input.variables,
  });

  const message = await WaMessage.create({
    businessId: ctx.businessId,
    conversationId: conv._id,
    direction: 'out',
    providerMessageId: sendResult.messageId,
    kind: input.templateId ? 'template' : 'text',
    text: input.text,
    templateId: input.templateId ? new Types.ObjectId(input.templateId) : undefined,
    variables: input.variables,
    status: sendResult.success ? 'sent' : 'failed',
    origin: 'inbox',
    sentBy: ctx.userId,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });

  conv.lastMessageAt = new Date();
  await conv.save();

  // Bump Redis change scope
  const redis = getRedisClient();
  await redis.incr(`chg:${ctx.businessId}:whatsapp`);

  return message;
}

// ----------------------------------------------------
// Webhook Processing
// ----------------------------------------------------

export async function processInboundWebhook(
  numberId: string | Types.ObjectId,
  payload: {
    from: string;
    text?: string;
    providerMessageId?: string;
    status?: string;
  }
) {
  const waNum = await WaNumber.findById(numberId);
  if (!waNum) return;

  const phone = normalizePhone(payload.from);

  let conv = await WaConversation.findOne({
    businessId: waNum.businessId,
    numberId: waNum._id,
    phone,
  });

  if (!conv) {
    const customer = await Customer.findOne({ businessId: waNum.businessId, phone });
    const branchId = waNum.branchIds.length > 0 ? waNum.branchIds[0] : new Types.ObjectId();

    conv = await WaConversation.create({
      businessId: waNum.businessId,
      numberId: waNum._id,
      branchId,
      phone,
      customerId: customer?._id,
      lastMessageAt: new Date(),
      lastInboundAt: new Date(),
      unread: 1,
    });
  } else {
    conv.lastMessageAt = new Date();
    conv.lastInboundAt = new Date();
    conv.unread += 1;
    await conv.save();
  }

  if (payload.text) {
    await WaMessage.create({
      businessId: waNum.businessId,
      conversationId: conv._id,
      direction: 'in',
      providerMessageId: payload.providerMessageId,
      kind: 'text',
      text: payload.text,
      status: 'delivered',
      origin: 'inbox',
    });

    // Check for 1-5 feedback reply
    const trimmed = payload.text.trim();
    const ratingNum = parseInt(trimmed, 10);
    if (!isNaN(ratingNum) && ratingNum >= 1 && ratingNum <= 5 && conv.customerId) {
      const recentBill = await Bill.findOne({
        businessId: waNum.businessId,
        customerId: conv.customerId,
        status: { $in: ['paid', 'partly_paid'] },
      }).sort({ createdAt: -1 });

      if (recentBill) {
        const existingFeedback = await Feedback.findOne({
          businessId: waNum.businessId,
          billId: recentBill._id,
        });

        if (!existingFeedback) {
          const isHighRating = ratingNum >= 4;
          const staffIds = (recentBill.lines || []).flatMap((it: any) => (it.staff || []).map((s: any) => s.staffId)).filter(Boolean) as Types.ObjectId[];
          await Feedback.create({
            businessId: waNum.businessId,
            branchId: recentBill.branchId,
            billId: recentBill._id,
            customerId: conv.customerId,
            staffIds,
            rating: ratingNum as any,
            comment: payload.text,
            reviewLinkSent: isHighRating,
          });
        }
      }
    }
  }

  const redis = getRedisClient();
  await redis.incr(`chg:${waNum.businessId}:whatsapp`);
}

// ----------------------------------------------------
// Campaigns & Automations
// ----------------------------------------------------

export async function createCampaign(
  ctx: RequestContext,
  input: z.infer<typeof createCampaignSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  let totalAudience = 0;
  if (input.audience.kind === 'selection') {
    totalAudience = input.audience.customerIds?.length || 0;
  } else if (input.audience.kind === 'segment') {
    totalAudience = await Customer.countDocuments({ businessId: ctx.businessId });
  }

  const campaign = await Campaign.create({
    businessId: ctx.businessId,
    name: input.name,
    numberId: input.numberId,
    templateId: input.templateId,
    audience: {
      ...input.audience,
      totalCount: totalAudience,
    },
    variableMap: input.variableMap,
    status: input.scheduledAt ? 'scheduled' : 'draft',
    scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
    stats: { sent: 0, delivered: 0, read: 0, failed: 0, costPaise: 0 },
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });

  await logAction({
    businessId: ctx.businessId,
    branchId: ctx.branchId,
    actorId: ctx.userId,
    actorRole: ctx.role,
    action: 'campaign.created',
    targetType: 'campaign',
    targetId: campaign._id,
    after: campaign.toObject(),
  });

  return campaign;
}

export async function getCampaigns(ctx: RequestContext) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  return Campaign.find({ businessId: ctx.businessId })
    .populate('templateId', 'name body')
    .sort({ createdAt: -1 });
}

export async function getAutomations(ctx: RequestContext) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  return Automation.find({ businessId: ctx.businessId }).populate('templateId', 'name body');
}

export async function updateAutomation(
  ctx: RequestContext,
  key: string,
  input: z.infer<typeof updateAutomationSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const auto = await Automation.findOneAndUpdate(
    { businessId: ctx.businessId, key },
    {
      businessId: ctx.businessId,
      key,
      enabled: input.enabled,
      templateId: input.templateId ? new Types.ObjectId(input.templateId) : undefined,
      settings: input.settings || {},
      updatedBy: ctx.userId,
    },
    { upsert: true, new: true }
  );

  await logAction({
    businessId: ctx.businessId,
    branchId: ctx.branchId,
    actorId: ctx.userId,
    actorRole: ctx.role,
    action: 'automation.updated',
    targetType: 'automation',
    targetId: auto._id,
    meta: { key, enabled: input.enabled },
  });

  return auto;
}

// ----------------------------------------------------
// Feedback
// ----------------------------------------------------

export async function submitFeedback(
  ctx: RequestContext,
  input: z.infer<typeof submitFeedbackSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const bill = await Bill.findOne({ _id: input.billId, businessId: ctx.businessId });
  if (!bill) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Bill not found');
  }

  const isHighRating = input.rating >= 4;

  const feedback = await Feedback.findOneAndUpdate(
    { businessId: ctx.businessId, billId: bill._id },
    {
      businessId: ctx.businessId,
      branchId: input.branchId,
      billId: bill._id,
      customerId: input.customerId,
      staffIds: input.staffIds.map((id) => new Types.ObjectId(id)),
      rating: input.rating,
      comment: input.comment,
      reviewLinkSent: isHighRating,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    },
    { upsert: true, new: true }
  );

  await logAction({
    businessId: ctx.businessId,
    branchId: new Types.ObjectId(input.branchId),
    actorId: ctx.userId,
    actorRole: ctx.role,
    action: 'feedback.submitted',
    targetType: 'feedback',
    targetId: feedback._id,
    meta: { rating: input.rating, billId: bill._id },
  });

  return feedback;
}
