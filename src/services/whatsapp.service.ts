import crypto from 'crypto';
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
  Appointment,
  AutomationSend,
  withTransaction,
} from '../models';
import { AppError, ErrorCode, normalizePhone, encrypt, decrypt, logger } from '../utils';
import { RequestContext, toObjectId } from './context';
import { logAction } from './audit.service';
import {
  sendInstantBroadcastMessage,
  fetchInstantBroadcastTemplates,
  instantBroadcastSocket,
  getRedisClient,
} from '../integrations';
import { emitToBranch } from '../socket';
import { whatsappSendQueue } from '../workers/queues';
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

  // One WhatsApp account belongs to one business: webhooks are routed by uid, so a shared uid would mix salons
  const clash = await WaNumber.findOne({
    businessId: { $ne: businessId },
    $or: [
      { phone },
      ...(uid ? [{ 'instantBroadcast.uid': uid }, { 'aisensy.projectId': uid }] : []),
    ],
  }).setOptions({ skipTenantScope: true });
  if (clash) {
    throw new AppError(409, ErrorCode.ALREADY_EXISTS, 'This WhatsApp account is already connected to another business', {
      fields: clash.phone === phone ? { phone: 'Already used by another business' } : { uid: 'Already used by another business' },
    });
  }

  // Keep the current webhook secret unless a new one is given; generate one for new numbers and weak old ones
  const existing = await WaNumber.findOne({ businessId, phone }).setOptions({ skipTenantScope: true });
  let currentSecret: string | undefined;
  try {
    const enc = existing?.instantBroadcast?.webhookSecretEnc || existing?.aisensy?.webhookSecretEnc;
    currentSecret = enc ? decrypt(enc) : undefined;
  } catch {
    currentSecret = undefined;
  }
  const webhookSecret =
    input.webhookSecret ||
    (currentSecret && !WEAK_WEBHOOK_SECRETS.includes(currentSecret) ? currentSecret : crypto.randomBytes(24).toString('hex'));
  const webhookSecretEnc = encrypt(webhookSecret);

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
    businessId,
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
    } catch { }
  }

  // Automatically fetch & sync templates (a Super Admin call carries the target business, not its own)
  await syncWaTemplates({ ...ctx, businessId: businessId.toString() }, waNum._id);

  // Shown to the Super Admin so they can paste it into the provider's webhook settings
  return { ...waNum.toObject(), webhookUrl: `/webhooks/instantbroadcast/${uid || waNum._id}?secret=${webhookSecret}` };
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

/** Managers and branch logins work only in their own branches' chats; owners in all. */
const inChatScope = (ctx: RequestContext, branchId: Types.ObjectId | string) =>
  ctx.role === 'owner' || ctx.branchIds.includes(branchId.toString());

/** Loads a conversation of the business; one outside the user's branches is reported as not found. */
async function findScopedConversation(ctx: RequestContext, conversationId: string | Types.ObjectId) {
  if (!Types.ObjectId.isValid(conversationId.toString())) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Conversation not found');
  }
  const conv = await WaConversation.findOne({ _id: conversationId, businessId: ctx.businessId });
  if (!conv || !inChatScope(ctx, conv.branchId)) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Conversation not found');
  }
  return conv;
}

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
    if (!inChatScope(ctx, branchId)) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'You do not have access to this branch');
    }
    query.branchId = toObjectId(branchId);
  } else if (ctx.role !== 'owner') {
    query.branchId = { $in: ctx.branchIds.map(toObjectId) };
  }

  if (filter?.unreadOnly) query.unread = { $gt: 0 };
  if (filter?.search) {
    const text = filter.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const digits = text.replace(/\D/g, '');
    const named = await Customer.find({ businessId: ctx.businessId, name: { $regex: text, $options: 'i' } }).select('_id').limit(200);
    query.$or = [
      { 'contactMeta.pushName': { $regex: text, $options: 'i' } },
      { customerId: { $in: named.map((c) => c._id) } },
      ...(digits ? [{ phone: { $regex: digits } }] : []),
    ];
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

  const scoped = await findScopedConversation(ctx, conversationId);
  return WaConversation.findOne({ _id: scoped._id, businessId: ctx.businessId })
    .populate('customerId', 'name phone email stats tags walletBalancePaise loyaltyPoints duePaise')
    .populate('leadId');
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

  const conv = await findScopedConversation(ctx, conversationId);

  // Newest page first (skip = how many newer messages to pass), returned oldest → newest for display
  const page = await WaMessage.find({ businessId: ctx.businessId, conversationId: conv._id })
    .sort({ createdAt: -1, _id: -1 })
    .skip(skip)
    .limit(Math.min(Math.max(limit, 1), 200));
  return page.reverse();
}

export async function sendMessage(
  ctx: RequestContext,
  conversationId: string | Types.ObjectId,
  input: z.infer<typeof sendWaMessageSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const conv = await findScopedConversation(ctx, conversationId);

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
    templateName,
    campaignName: templateName,
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
  emitToBranch(ctx.businessId.toString(), conv.branchId.toString(), 'wa:new_message', {
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

  const conv = await findScopedConversation(ctx, conversationId);
  conv.unread = 0;
  await conv.save();

  // Emit to Instant Broadcast socket engine if providerChatId exists
  if (conv.providerChatId) {
    const waNum = await WaNumber.findOne({ _id: conv.numberId, businessId: ctx.businessId });
    const uid = waNum?.instantBroadcast?.uid || waNum?.aisensy?.projectId;
    if (uid) {
      instantBroadcastSocket.markChatRead(uid, conv.providerChatId);
    }
  }

  emitToBranch(ctx.businessId.toString(), conv.branchId.toString(), 'wa:chat_read', { conversationId: conv._id });
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

  const scoped = await findScopedConversation(ctx, conversationId);
  const conv = (await WaConversation.findOneAndUpdate(
    { _id: scoped._id, businessId: ctx.businessId },
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
  ))!;

  if (conv.providerChatId) {
    const waNum = await WaNumber.findOne({ _id: conv.numberId, businessId: ctx.businessId });
    const uid = waNum?.instantBroadcast?.uid || waNum?.aisensy?.projectId;
    if (uid) {
      instantBroadcastSocket.saveChatNote(uid, conv.providerChatId, note);
    }
  }

  emitToBranch(ctx.businessId.toString(), conv.branchId.toString(), 'wa:chat_note_saved', {
    conversationId: conv._id,
    note: conv.notes?.[conv.notes.length - 1],
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

/** The WhatsApp number a webhook URL points at: by our id, the Instant Broadcast uid or the AiSensy project. */
export async function findWaNumberForWebhook(identifier: string | Types.ObjectId) {
  let waNum = null;
  if (Types.ObjectId.isValid(identifier)) {
    waNum = await WaNumber.findById(identifier).setOptions({ skipTenantScope: true });
  }
  if (!waNum) {
    const matches = await WaNumber.find({
      $or: [
        { 'instantBroadcast.uid': String(identifier) },
        { 'aisensy.projectId': String(identifier) },
      ],
    })
      .limit(2)
      .setOptions({ skipTenantScope: true });
    // Saved before the one-business-per-account check: refuse rather than guess which salon gets the message
    if (matches.length > 1) {
      logger.error({ identifier }, 'Webhook uid is connected to more than one business; message dropped');
      return null;
    }
    waNum = matches[0] || null;
  }
  return waNum;
}

/**
 * Reopens the live Instant Broadcast connection for every active number of every business.
 * Called once at server start; connections were only opened when a number was saved, so a restart dropped them.
 */
export async function reconnectAllWaNumbers(): Promise<number> {
  const numbers = await WaNumber.find({ status: 'active', 'instantBroadcast.uid': { $exists: true, $ne: '' } })
    .setOptions({ skipTenantScope: true });
  let connected = 0;
  for (const n of numbers) {
    try {
      const token = n.instantBroadcast?.userTokenEnc ? decrypt(n.instantBroadcast.userTokenEnc) : '';
      if (!token) continue;
      instantBroadcastSocket.connectAccount({
        uid: n.instantBroadcast!.uid,
        userToken: token,
        businessId: n.businessId.toString(),
        numberId: n._id.toString(),
      });
      connected++;
    } catch (err: any) {
      logger.warn({ err: err.message, numberId: n._id }, 'Could not reconnect WhatsApp number');
    }
  }
  return connected;
}

/** Constant-time check of the secret sent with a webhook against the number's stored secret. */
export function webhookSecretMatches(waNum: any, provided: string | undefined): boolean {
  const enc = waNum?.instantBroadcast?.webhookSecretEnc || waNum?.aisensy?.webhookSecretEnc;
  if (!enc || !provided) return false;
  let expected: string;
  try {
    expected = decrypt(enc);
  } catch {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Old builds stored these placeholders as the secret; they are replaced on the next save. */
const WEAK_WEBHOOK_SECRETS = ['secret', 'default-webhook-secret'];

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
  const waNum = await findWaNumberForWebhook(numberId);
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
      const statusConv = await WaConversation.findOne({ _id: updated.conversationId, businessId: waNum.businessId }).select('branchId');
      if (statusConv) {
        emitToBranch(waNum.businessId.toString(), statusConv.branchId.toString(), 'wa:message_status', {
          conversationId: updated.conversationId,
          messageId: updated._id,
          providerMessageId: payload.providerMessageId,
          status: payload.status,
        });
      }
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
    ? await Branch.findOne({ _id: business.headBranchId, businessId: waNum.businessId })
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

    emitToBranch(waNum.businessId.toString(), conv.branchId.toString(), 'wa:new_message', {
      conversationId: conv._id,
      message: msg,
    });

    // Check for 1-5 feedback reply
    if (payload.text) {
      const trimmed = payload.text.trim();
      const ratingNum = parseInt(trimmed, 10);
      if (!isNaN(ratingNum) && ratingNum >= 1 && ratingNum <= 5 && conv.customerId) {
        const recentAppt = await Appointment.findOne({
          businessId: waNum.businessId,
          customerId: conv.customerId,
          status: { $in: ['completed', 'billed'] },
        }).sort({ updatedAt: -1 });

        const recentBill = await Bill.findOne({
          businessId: waNum.businessId,
          customerId: conv.customerId,
          status: { $in: ['paid', 'partly_paid'] },
        }).sort({ createdAt: -1 });

        const billId = recentBill?._id || recentAppt?.billId;
        const branchId = recentAppt?.branchId || recentBill?.branchId;
        const staffIds = recentBill
          ? (recentBill.lines || []).flatMap((it: any) => (it.staff || []).map((s: any) => s.staffId)).filter(Boolean)
          : (recentAppt?.lines || []).map((l: any) => l.staffId).filter(Boolean);

        const existingFeedback = await Feedback.findOne({
          businessId: waNum.businessId,
          $or: [
            ...(billId ? [{ billId }] : []),
            ...(recentAppt ? [{ appointmentId: recentAppt._id }] : []),
          ],
        });

        if (!existingFeedback && (billId || recentAppt)) {
          const isHighRating = ratingNum >= 4;
          const feedback = await Feedback.create({
            businessId: waNum.businessId,
            branchId,
            billId,
            appointmentId: recentAppt?._id,
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
          } else if (isHighRating && branchId) {
            const branch = await Branch.findOne({ _id: branchId, businessId: waNum.businessId });
            if (branch?.googleReviewUrl) {
              const reviewMsg = await WaMessage.create({
                businessId: waNum.businessId,
                conversationId: conv._id,
                direction: 'out',
                kind: 'text',
                text: `Thank you so much for your kind rating! ⭐ If you have a moment, we would love it if you could share your review on Google: ${branch.googleReviewUrl}`,
                origin: 'automation',
                originId: feedback._id,
                status: 'queued',
              });

              await whatsappSendQueue().add(
                'send',
                { messageId: reviewMsg._id.toString() },
                { jobId: reviewMsg._id.toString() }
              );
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
    },
    variableMap: input.variableMap,
    status: input.scheduledAt ? 'scheduled' : 'draft',
    scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
    stats: { total: totalAudience, sent: 0, delivered: 0, read: 0, failed: 0, excluded, costPaise: 0 },
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

/**
 * Sends a Thank You & 1-5 feedback WhatsApp prompt immediately after an appointment is completed.
 */
export async function sendAppointmentFeedbackMessage(
  appointmentId: string | Types.ObjectId
): Promise<void> {
  const appt = await Appointment.findById(appointmentId).setOptions({ skipTenantScope: true });
  if (!appt || appt.status !== 'completed') return;

  const customer = await Customer.findOne({ _id: appt.customerId, businessId: appt.businessId });
  if (!customer || !customer.phone || customer.doNotMessage || customer.waOptIn === false) return;

  const dedupeId = `feedback:appointment:${appt._id}`;
  const existing = await AutomationSend.findById(dedupeId);
  if (existing) return;

  const waNumber = await WaNumber.findOne({ businessId: appt.businessId, status: 'active' });
  if (!waNumber) return;

  const branch = await Branch.findOne({ _id: appt.branchId, businessId: appt.businessId });
  const business = await Business.findById(appt.businessId);
  const salonName = branch?.name || business?.name || 'our salon';

  let conversation = await WaConversation.findOne({
    businessId: appt.businessId,
    numberId: waNumber._id,
    phone: customer.phone,
  });

  if (!conversation) {
    conversation = await WaConversation.create({
      businessId: appt.businessId,
      numberId: waNumber._id,
      branchId: appt.branchId,
      phone: customer.phone,
      customerId: customer._id,
      lastMessageAt: new Date(),
      unread: 0,
    });
  }

  // Look for post_service_feedback template if approved
  const tpl = await WaTemplate.findOne({
    businessId: appt.businessId,
    name: 'post_service_feedback',
    status: 'approved',
  });

  const feedbackText = `Hi ${customer.name}, thank you for visiting ${salonName} today! ✨ We hope you loved your service. How would you rate your experience with us? Please reply with a number from 1 to 5 (1 = Poor, 5 = Excellent).`;

  const msg = await WaMessage.create({
    businessId: appt.businessId,
    conversationId: conversation._id,
    direction: 'out',
    kind: tpl ? 'template' : 'text',
    templateId: tpl?._id,
    variables: tpl ? [customer.name, salonName] : undefined,
    text: feedbackText,
    origin: 'automation',
    originId: appt._id,
    status: 'queued',
  });

  await AutomationSend.create({
    _id: dedupeId,
    businessId: appt.businessId,
    messageId: msg._id,
    at: new Date(),
  });

  await whatsappSendQueue().add(
    'send',
    { messageId: msg._id.toString() },
    { jobId: msg._id.toString() }
  );
}
