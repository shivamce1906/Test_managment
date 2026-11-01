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
  Branch,
  Business,
  Notification,
  Lead,
  User,
  withTransaction,
} from '../models';
import { AppError, ErrorCode, normalizePhone, encrypt, decrypt } from '../utils';
import { RequestContext, toObjectId } from './context';
import { logAction } from './audit.service';
import {
  sendInstantBroadcastMessage,
  fetchInstantBroadcastTemplates,
  instantBroadcastSocket,
  getRedisClient,
} from '../integrations';
import { emitToBusiness } from '../socket';
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
  const rawToken = input.userToken || input.apiKey || '';
  const uid = input.uid || input.projectId || '';
  const tokenEnc = encrypt(rawToken);
  const webhookSecretEnc = encrypt(input.webhookSecret || 'secret');

  const waNum = await WaNumber.findOneAndUpdate(
    { businessId, phone },
    {
      businessId,
      phone,
      provider: 'instant_broadcast',
      instantBroadcast: {
        uid,
        userTokenEnc: tokenEnc,
        apiKeyEnc: tokenEnc,
        webhookSecretEnc,
      },
      aisensy: {
        apiKeyEnc: tokenEnc,
        projectId: uid,
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
    meta: { phone, uid },
  });

  // Automatically connect Instant Broadcast socket engine
  if (uid && rawToken) {
    try {
      instantBroadcastSocket.connectAccount({
        uid,
        userToken: rawToken,
        businessId: businessId.toString(),
        numberId: waNum._id.toString(),
      });
    } catch {}
  }

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
    uid: n.instantBroadcast?.uid || n.aisensy?.projectId,
    projectId: n.instantBroadcast?.uid || n.aisensy?.projectId,
    provider: n.provider || 'instant_broadcast',
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

  const tokenEnc = waNum.instantBroadcast?.userTokenEnc || waNum.aisensy?.apiKeyEnc;
  const token = tokenEnc ? decrypt(tokenEnc) : '';
  const uid = waNum.instantBroadcast?.uid || waNum.aisensy?.projectId;
  const externalTemplates = await fetchInstantBroadcastTemplates(token, uid);

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
        status: t.status === 'approved' || t.status === 'APPROVED' ? 'approved' : 'pending',
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
  if (branchId) {
    query.branchId = branchId;
  } else if (ctx.role === 'manager' || ctx.role === 'branch') {
    if (ctx.branchId) {
      query.branchId = ctx.branchId;
    } else if (ctx.branchIds && ctx.branchIds.length > 0) {
      query.branchId = { $in: ctx.branchIds.map(toObjectId) };
    }
  }

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
        422,
        'WINDOW_CLOSED',
        'Cannot send free-form message outside 24-hour customer response window. Use an approved template.'
      );
    }
  }

  const waNum = await WaNumber.findOne({ _id: conv.numberId, businessId: ctx.businessId });
  if (!waNum) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'WhatsApp configuration not found');
  }

  const tokenEnc = waNum.instantBroadcast?.userTokenEnc || waNum.aisensy?.apiKeyEnc;
  const token = tokenEnc ? decrypt(tokenEnc) : '';
  const uid = waNum.instantBroadcast?.uid || waNum.aisensy?.projectId;

  let templateName: string | undefined;
  if (input.templateId) {
    const tmpl = await WaTemplate.findOne({ _id: input.templateId, businessId: ctx.businessId });
    if (!tmpl || tmpl.status !== 'approved') {
      throw new AppError(422, ErrorCode.TEMPLATE_NOT_APPROVED, 'Template not found or not approved');
    }
    templateName = tmpl.name;
  }

  const sendResult = await sendInstantBroadcastMessage({
    apiKey: token,
    userToken: token,
    uid,
    campaignName: templateName || 'direct_message',
    destination: conv.phone,
    userName: 'Customer',
    templateParams: input.variables,
    text: input.text,
    kind: input.templateId ? 'template' : 'text',
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

  // Notify frontend clients via socket
  emitToBusiness(ctx.businessId.toString(), 'wa:new_message', {
    conversationId: conv._id,
    message,
  });

  // Bump Redis change scope
  const redis = getRedisClient();
  await redis.incr(`chg:${ctx.businessId}:whatsapp`);

  return message;
}

// ----------------------------------------------------
// Chat Actions (Mark Read & Internal Notes)
// ----------------------------------------------------

export async function markChatRead(
  ctx: RequestContext,
  conversationId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const conv = await WaConversation.findOneAndUpdate(
    { _id: conversationId, businessId: ctx.businessId },
    { $set: { unread: 0 } },
    { new: true }
  );

  if (!conv) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Conversation not found');
  }

  // Emit to Instant Broadcast socket engine if providerChatId exists
  if (conv.providerChatId) {
    const waNum = await WaNumber.findById(conv.numberId);
    const uid = waNum?.instantBroadcast?.uid || waNum?.aisensy?.projectId;
    if (uid) {
      instantBroadcastSocket.markChatRead(uid, conv.providerChatId);
    }
  }

  emitToBusiness(ctx.businessId.toString(), 'wa:chat_read', { conversationId: conv._id });
  return conv;
}

export async function saveChatNote(
  ctx: RequestContext,
  conversationId: string | Types.ObjectId,
  note: string
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const conv = await WaConversation.findOneAndUpdate(
    { _id: conversationId, businessId: ctx.businessId },
    {
      $push: {
        notes: {
          note,
          authorId: ctx.userId ? toObjectId(ctx.userId) : undefined,
          createdAt: new Date(),
        },
      },
    },
    { new: true }
  );

  if (!conv) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Conversation not found');
  }

  if (conv.providerChatId) {
    const waNum = await WaNumber.findById(conv.numberId);
    const uid = waNum?.instantBroadcast?.uid || waNum?.aisensy?.projectId;
    if (uid) {
      instantBroadcastSocket.saveChatNote(uid, conv.providerChatId, note);
    }
  }

  emitToBusiness(ctx.businessId.toString(), 'wa:chat_note_saved', {
    conversationId: conv._id,
    note,
  });

  return conv;
}

export async function updateConversationContactMeta(
  businessId: string | Types.ObjectId,
  providerChatId: string,
  meta: { pushName?: string; profilePicUrl?: string }
) {
  return WaConversation.findOneAndUpdate(
    { businessId, providerChatId },
    { $set: { contactMeta: meta } },
    { new: true }
  );
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
    mediaUrl?: string;
    senderName?: string;
    providerChatId?: string;
  }
) {
  let waNum = null;
  if (Types.ObjectId.isValid(numberId)) {
    waNum = await WaNumber.findById(numberId).setOptions({ skipTenantScope: true });
  }
  if (!waNum) {
    waNum = await WaNumber.findOne({
      $or: [
        { 'instantBroadcast.uid': numberId },
        { 'aisensy.projectId': numberId },
      ],
    }).setOptions({ skipTenantScope: true });
  }
  if (!waNum) return;

  const phone = normalizePhone(payload.from);

  // 1. Delivery status callback on existing outbound message
  if (payload.status && payload.providerMessageId) {
    const updated = await WaMessage.findOneAndUpdate(
      { businessId: waNum.businessId, providerMessageId: payload.providerMessageId },
      { $set: { status: payload.status as any } },
      { new: true }
    );
    if (updated) {
      emitToBusiness(waNum.businessId.toString(), 'wa:message_status', {
        providerMessageId: payload.providerMessageId,
        status: payload.status,
      });
      return;
    }
  }

  // 2. Duplicate provider message check
  if (payload.providerMessageId) {
    const existing = await WaMessage.findOne({
      businessId: waNum.businessId,
      providerMessageId: payload.providerMessageId,
    });
    if (existing) return;
  }

  // 3. Find or link Customer / Lead
  const customer = await Customer.findOne({ businessId: waNum.businessId, phone });
  let lead = null;
  if (!customer) {
    lead = await Lead.findOne({ businessId: waNum.businessId, phone });
    if (!lead) {
      const headBranch = await Branch.findOne({ businessId: waNum.businessId }).sort({ createdAt: 1 });
      const branchId = waNum.branchIds.length > 0 ? waNum.branchIds[0] : (headBranch?._id || new Types.ObjectId());
      lead = await Lead.create({
        businessId: waNum.businessId,
        branchId,
        name: payload.senderName || 'WhatsApp Lead',
        phone,
        source: 'whatsapp',
        stage: 'new',
      });
    }
  }

  const business = await Business.findById(waNum.businessId);
  const headBranch = business?.headBranchId
    ? await Branch.findById(business.headBranchId)
    : await Branch.findOne({ businessId: waNum.businessId }).sort({ createdAt: 1 });

  const defaultBranchId = waNum.branchIds.length > 0
    ? waNum.branchIds[0]
    : (lead?.branchId || headBranch?._id || new Types.ObjectId());

  let conv = await WaConversation.findOne({
    businessId: waNum.businessId,
    numberId: waNum._id,
    phone,
  });

  if (!conv) {
    conv = await WaConversation.create({
      businessId: waNum.businessId,
      numberId: waNum._id,
      branchId: defaultBranchId,
      phone,
      providerChatId: payload.providerChatId,
      customerId: customer?._id,
      leadId: lead?._id,
      lastMessageAt: new Date(),
      lastInboundAt: new Date(),
      unread: 1,
    });
  } else {
    conv.lastMessageAt = new Date();
    conv.lastInboundAt = new Date();
    conv.unread += 1;
    if (payload.providerChatId && !conv.providerChatId) {
      conv.providerChatId = payload.providerChatId;
    }
    if (customer?._id && !conv.customerId) {
      conv.customerId = customer._id;
    }
    if (lead?._id && !conv.leadId) {
      conv.leadId = lead._id;
    }
    await conv.save();
  }

  // 4. Opt-out check for 'STOP'
  if (payload.text && payload.text.trim().toUpperCase() === 'STOP') {
    if (customer) {
      await Customer.updateOne(
        { _id: customer._id, businessId: waNum.businessId },
        { $set: { waOptIn: false, doNotMessage: true } }
      );
    }
  }

  // 5. Create inbound message
  if (payload.text || payload.mediaUrl) {
    const msg = await WaMessage.create({
      businessId: waNum.businessId,
      conversationId: conv._id,
      direction: 'in',
      providerMessageId: payload.providerMessageId,
      kind: payload.mediaUrl ? 'media' : 'text',
      text: payload.text,
      mediaUrl: payload.mediaUrl,
      senderName: payload.senderName,
      status: 'delivered',
      origin: 'inbox',
    });

    emitToBusiness(waNum.businessId.toString(), 'wa:new_message', {
      conversationId: conv._id,
      message: msg,
    });

    // Check for 1-5 feedback reply
    if (payload.text) {
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
            const feedback = await Feedback.create({
              businessId: waNum.businessId,
              branchId: recentBill.branchId,
              billId: recentBill._id,
              customerId: conv.customerId,
              staffIds,
              rating: ratingNum as any,
              comment: payload.text,
              reviewLinkSent: isHighRating,
            });

            if (ratingNum <= 3) {
              const owner = await User.findOne({ businessId: waNum.businessId, role: 'owner' });
              if (owner) {
                await Notification.create({
                  businessId: waNum.businessId,
                  userId: owner._id,
                  type: 'low_feedback',
                  title: 'Low Rating Received',
                  body: `Customer left a rating of ${ratingNum}/5`,
                });
              }
            }
          }
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

  // Verify number and template belong to business
  const waNum = await WaNumber.findOne({ _id: input.numberId, businessId: ctx.businessId });
  if (!waNum) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'WhatsApp number not found for this business');
  }
  const waTpl = await WaTemplate.findOne({ _id: input.templateId, businessId: ctx.businessId });
  if (!waTpl) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'WhatsApp template not found for this business');
  }

  let totalAudience = 0;
  let excluded = 0;
  if (input.audience.kind === 'selection') {
    const rawIds = input.audience.customerIds || [];
    const eligibleCustomers = await Customer.find({
      _id: { $in: rawIds },
      businessId: ctx.businessId,
      waOptIn: true,
      doNotMessage: false,
    });
    totalAudience = eligibleCustomers.length;
    excluded = rawIds.length - totalAudience;
  } else if (input.audience.kind === 'segment') {
    totalAudience = await Customer.countDocuments({
      businessId: ctx.businessId,
      waOptIn: true,
      doNotMessage: false,
    });
    const totalAll = await Customer.countDocuments({ businessId: ctx.businessId });
    excluded = totalAll - totalAudience;
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
    stats: { sent: 0, delivered: 0, read: 0, failed: 0, excluded, costPaise: 0 },
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

  const VALID_KEYS = [
    'booking_confirmation',
    'reminder_24h',
    'reminder_2h',
    'rebooking',
    'birthday',
    'anniversary',
    'winback',
    'feedback',
    'review_push',
    'membership_expiry',
    'package_last_session',
  ];
  if (!VALID_KEYS.includes(key)) {
    throw new AppError(400, ErrorCode.BAD_REQUEST, `Invalid automation key: ${key}`);
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
