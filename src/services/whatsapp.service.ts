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
import { AppError, ErrorCode, normalizePhone, encrypt, decrypt, logger, getBusinessDate, formatIstTime } from '../utils';
import { RequestContext, toObjectId } from './context';
import { logAction } from './audit.service';
import {
  instantBroadcastAdapter,
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

  const connectionCheck = await instantBroadcastAdapter.verifyConnection(rawToken, uid);
  if (connectionCheck.unauthorized) {
    throw new AppError(422, ErrorCode.WA_NOT_CONFIGURED, connectionCheck.error || 'WhatsApp provider rejected these credentials');
  }

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
  return {
    ...waNum.toObject(),
    webhookUrl: `/webhooks/instantbroadcast/${uid || waNum._id}?secret=${webhookSecret}`,
    connectionCheck,
  };
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

  // A successful send proves the WhatsApp balance is fine again (F-23): clear the low-balance flag
  // and tell the owner. Campaigns paused for low balance stay paused until the owner resumes them.
  if (sendResult.success && !sendResult.lowBalance && waNum.lowBalance) {
    await WaNumber.updateOne({ _id: waNum._id, businessId: waNum.businessId }, { $set: { lowBalance: false } });
    const owner = await User.findOne({ businessId: waNum.businessId, role: 'owner', status: 'active' }).select('_id');
    if (owner) {
      await Notification.create({
        businessId: waNum.businessId,
        userId: owner._id,
        type: 'wa_balance_restored',
        title: 'WhatsApp balance restored',
        body: 'Messages are going out again. Campaigns paused for low balance stay paused until you resume them.',
      });
    }
  }

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
    error: sendResult.error,
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

/**
 * The branch a new chat belongs to: the number's first branch, else the head branch, else the
 * oldest branch. Never the business id, which no manager or branch login could ever see.
 */
export async function defaultChatBranchId(businessId: Types.ObjectId | string, waNum: { branchIds?: Types.ObjectId[] }) {
  if (waNum.branchIds?.length) return waNum.branchIds[0];
  const business = await Business.findById(businessId).select('headBranchId');
  const head = business?.headBranchId
    ? await Branch.findOne({ _id: business.headBranchId, businessId }).select('_id')
    : null;
  const branch = head || (await Branch.findOne({ businessId }).sort({ createdAt: 1 }).select('_id'));
  if (!branch) throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'This business has no branch to put the chat in');
  return branch._id;
}

const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

/**
 * Moves one outbound message's tick forward (sent → delivered → read; failed always applies) and
 * tells its branch. Providers resend old states, so a tick never goes back. False = no such message.
 */
export async function applyMessageStatus(businessId: Types.ObjectId | string, providerMessageId: string, status: string) {
  const message = await WaMessage.findOne({ businessId, providerMessageId });
  if (!message) return false;
  const forward = status === 'failed' || (STATUS_RANK[status] ?? -1) > (STATUS_RANK[message.status] ?? 0);
  if (!forward || message.status === status) return true;

  message.status = status as any;
  await message.save();
  const conv = await WaConversation.findOne({ _id: message.conversationId, businessId }).select('branchId');
  if (conv) {
    emitToBranch(businessId.toString(), conv.branchId.toString(), 'wa:message_status', {
      conversationId: message.conversationId,
      messageId: message._id,
      providerMessageId,
      status,
    });
  }
  return true;
}


/** Milliseconds until quiet hours (IST, e.g. 21:00-09:00) end, or 0 when it is not quiet now. */
function msUntilQuietEnds(quietStart: string, quietEnd: string, now: Date = new Date()): number {
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const cur = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const start = toMin(quietStart);
  const end = toMin(quietEnd);
  const quiet = start <= end ? cur >= start && cur < end : cur >= start || cur < end;
  if (!quiet) return 0;
  return (((end - cur + 24 * 60) % (24 * 60)) || 24 * 60) * 60 * 1000;
}

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
    /** When the customer sent it (providers replay old messages); defaults to now. */
    sentAt?: Date;
  }
) {
  const waNum = await findWaNumberForWebhook(numberId);
  if (!waNum) return;
  const now = new Date();
  const sentAt = payload.sentAt && !Number.isNaN(payload.sentAt.getTime()) && payload.sentAt < now ? payload.sentAt : now;
  const later = (a: Date | undefined) => (a && a > sentAt ? a : sentAt);

  const phone = normalizePhone(payload.from);

  // 1. Delivery status callback on existing outbound message
  if (payload.status && payload.providerMessageId) {
    if (await applyMessageStatus(waNum.businessId, payload.providerMessageId, payload.status)) return;
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
      const branchId = await defaultChatBranchId(waNum.businessId, waNum);
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

  const defaultBranchId = waNum.branchIds.length > 0
    ? waNum.branchIds[0]
    : (lead?.branchId || (await defaultChatBranchId(waNum.businessId, waNum)));

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
      lastMessageAt: sentAt,
      lastInboundAt: sentAt,
      unread: 1,
    });
  } else {
    // The 24-hour window counts from when the customer wrote, not when we heard about it
    conv.lastMessageAt = later(conv.lastMessageAt);
    conv.lastInboundAt = later(conv.lastInboundAt);
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
      createdAt: sentAt,
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
            reviewLinkSent: false, // set to true below only if the review link is actually queued
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
            // Sent only when the owner switched "review_push" on (off by default). It is a marketing
            // message: it counts towards the daily marketing limit and waits for quiet hours to end.
            const reviewAuto = await Automation.findOne({ businessId: waNum.businessId, key: 'review_push', enabled: true });
            const business = await Business.findById(waNum.businessId).select('automationGuards').lean();
            const guards: any = business?.automationGuards || {};
            const todayStr = getBusinessDate();
            const maxPerDay = Number.isInteger(guards.maxMarketingPerDay) ? guards.maxMarketingPerDay : 1;
            const marketingToday = conv.customerId
              ? await AutomationSend.countDocuments({ businessId: waNum.businessId, _id: { $regex: `^mktcap:${conv.customerId}:${todayStr}:` } })
              : 0;
            const underCap = maxPerDay > 0 && marketingToday < maxPerDay;
            if (branch?.googleReviewUrl && reviewAuto && underCap) {
              const dedupeKey = `review_push:${feedback._id}`;
              const already = await AutomationSend.findById(dedupeKey);
              if (!already) {
                const reviewTpl = reviewAuto?.templateId
                  ? await WaTemplate.findOne({ _id: reviewAuto.templateId, businessId: waNum.businessId, status: 'approved' })
                  : await WaTemplate.findOne({ businessId: waNum.businessId, name: 'review_push', status: 'approved' });
                const custDoc = await Customer.findOne({ _id: conv.customerId, businessId: waNum.businessId });
                const reviewMsg = await WaMessage.create({
                  businessId: waNum.businessId,
                  conversationId: conv._id,
                  direction: 'out',
                  kind: reviewTpl ? 'template' : 'text',
                  templateId: reviewTpl?._id,
                  variables: reviewTpl ? [custDoc?.name || 'Customer', branch.googleReviewUrl] : undefined,
                  text: `Thank you so much for your kind rating! ⭐ If you have a moment, we would love it if you could share your review on Google: ${branch.googleReviewUrl}`,
                  origin: 'automation',
                  originId: feedback._id,
                  status: 'queued',
                });

                await AutomationSend.create({
                  _id: dedupeKey,
                  businessId: waNum.businessId,
                  messageId: reviewMsg._id,
                  at: new Date(),
                });
                if (conv.customerId) {
                  await AutomationSend.create({
                    _id: `mktcap:${conv.customerId}:${todayStr}:${reviewMsg._id}`,
                    businessId: waNum.businessId,
                    messageId: reviewMsg._id,
                    at: new Date(),
                  });
                }

                // In quiet hours (IST) the message waits until they end
                const delay = msUntilQuietEnds(guards.quietStart || '21:00', guards.quietEnd || '09:00');
                // A queue problem must not fail the customer's incoming message (the webhook would be retried)
                await whatsappSendQueue()
                  .add(
                    'send',
                    { messageId: reviewMsg._id.toString(), businessId: String(waNum.businessId) },
                    { jobId: reviewMsg._id.toString(), ...(delay > 0 ? { delay } : {}) }
                  )
                  .catch((err: any) => logger.warn({ err, messageId: reviewMsg._id }, 'Review message could not be queued'));
                await Feedback.updateOne({ _id: feedback._id, businessId: waNum.businessId }, { $set: { reviewLinkSent: true } });
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

const ALL_AUTOMATION_KEYS = [
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
] as const;

export async function getAutomations(ctx: RequestContext) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const existing = await Automation.find({ businessId: ctx.businessId }).select('key');
  const existingKeys = new Set(existing.map((a) => a.key));
  const missingKeys = ALL_AUTOMATION_KEYS.filter((k) => !existingKeys.has(k));
  if (missingKeys.length > 0) {
    await Automation.insertMany(
      missingKeys.map((key) => ({
        businessId: ctx.businessId,
        key,
        enabled: false,
        settings: {},
      })),
      { ordered: false }
    ).catch(() => {});
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

  if (!(ALL_AUTOMATION_KEYS as readonly string[]).includes(key)) {
    throw new AppError(400, ErrorCode.BAD_REQUEST, `Invalid automation key: ${key}`);
  }

  const updateSet: Record<string, any> = {
    enabled: input.enabled,
    updatedBy: ctx.userId,
  };
  if (input.templateId !== undefined) {
    updateSet.templateId = input.templateId ? new Types.ObjectId(input.templateId) : undefined;
  }
  if (input.settings !== undefined) {
    updateSet.settings = input.settings;
  }

  const auto = await Automation.findOneAndUpdate(
    { businessId: ctx.businessId, key },
    {
      $set: updateSet,
      $setOnInsert: { businessId: ctx.businessId, key },
    },
    { upsert: true, new: true }
  ).populate('templateId', 'name body');

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
      // Feedback entered by staff does not send a review link (only a customer's WhatsApp reply does)
      reviewLinkSent: false,
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
 * Sends a Booking Confirmation WhatsApp notification when enabled for the business.
 */
export async function sendBookingConfirmationMessage(
  appointmentId: string | Types.ObjectId
): Promise<void> {
  const appt = await Appointment.findById(appointmentId).setOptions({ skipTenantScope: true });
  if (!appt || appt.status === 'cancelled') return;

  const auto = await Automation.findOne({ businessId: appt.businessId, key: 'booking_confirmation' });
  if (!auto || !auto.enabled) return;

  const customer = await Customer.findOne({ _id: appt.customerId, businessId: appt.businessId });
  if (!customer || !customer.phone || customer.doNotMessage || customer.waOptIn === false) return;

  const dedupeId = `booking_confirmation:${appt._id}`;
  if (await AutomationSend.findById(dedupeId)) return;

  const waNumber = await WaNumber.findOne({ businessId: appt.businessId, status: 'active' });
  if (!waNumber) return;

  const [branch, business] = await Promise.all([
    Branch.findOne({ _id: appt.branchId, businessId: appt.businessId }),
    Business.findById(appt.businessId),
  ]);
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

  const tpl = auto.templateId
    ? await WaTemplate.findOne({ _id: auto.templateId, businessId: appt.businessId, status: 'approved' })
    : await WaTemplate.findOne({ businessId: appt.businessId, name: 'booking_confirmation', status: 'approved' });

  const dateStr = appt.businessDate || getBusinessDate(appt.start);
  const timeStr = formatIstTime(appt.start);
  const confirmText = `Hi ${customer.name}, your appointment at ${salonName} is confirmed for ${dateStr} at ${timeStr}.`;

  const msg = await WaMessage.create({
    businessId: appt.businessId,
    conversationId: conversation._id,
    direction: 'out',
    kind: tpl ? 'template' : 'text',
    templateId: tpl?._id,
    variables: tpl ? [customer.name, salonName, dateStr, timeStr] : undefined,
    text: confirmText,
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

/**
 * Sends a Thank You & 1-5 feedback WhatsApp prompt immediately after an appointment is completed.
 */
export async function sendAppointmentFeedbackMessage(
  appointmentId: string | Types.ObjectId
): Promise<void> {
  const appt = await Appointment.findById(appointmentId).setOptions({ skipTenantScope: true });
  if (!appt || appt.status !== 'completed') return;

  const feedbackAuto = await Automation.findOne({ businessId: appt.businessId, key: 'feedback' });
  if (feedbackAuto && !feedbackAuto.enabled) return;

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

  // Look for configured automation template or approved post_service_feedback template
  const tpl = feedbackAuto?.templateId
    ? await WaTemplate.findOne({ _id: feedbackAuto.templateId, businessId: appt.businessId, status: 'approved' })
    : await WaTemplate.findOne({
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
