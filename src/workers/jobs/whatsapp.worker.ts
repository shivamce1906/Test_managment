import { Worker, Job } from 'bullmq';
import { Types } from 'mongoose';
import ExcelJS from 'exceljs';
import { getBullConnection, sendInstantBroadcastMessage, fetchInstantBroadcastTemplates, s3Adapter } from '../../integrations';
import {
  WaMessage,
  WaNumber,
  WaTemplate,
  WaConversation,
  Campaign,
  Customer,
  Business,
  User,
  Notification,
  MarketingOffer,
  MarketingSegment,
  AutomationSend,
} from '../../models';
import { logger, decrypt, getBusinessDate, normalizePhone } from '../../utils';
import { toObjectId } from '../../services';
import { segmentationService } from '../../services/segmentation.service';
import { defaultChatBranchId } from '../../services/whatsapp.service';
import { whatsappSendQueue, campaignSendQueue } from '../queues';

function parseClockMinutes(hhmm: string | undefined, fallback: number): number {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return fallback;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function getIstClockMinutes(now: Date = new Date()): number {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function isQuietHoursIst(guards?: { quietStart?: string; quietEnd?: string }, now: Date = new Date()): boolean {
  const startMin = parseClockMinutes(guards?.quietStart, 21 * 60);
  const endMin = parseClockMinutes(guards?.quietEnd, 9 * 60);
  const curMin = getIstClockMinutes(now);
  if (startMin > endMin) {
    return curMin >= startMin || curMin < endMin;
  }
  return curMin >= startMin && curMin < endMin;
}

function msUntilQuietEndIst(guards?: { quietStart?: string; quietEnd?: string }, now: Date = new Date()): number {
  const endMin = parseClockMinutes(guards?.quietEnd, 9 * 60);
  const curMin = getIstClockMinutes(now);
  const diffMin = curMin < endMin ? endMin - curMin : 24 * 60 - curMin + endMin;
  return Math.max(60 * 1000, diffMin * 60 * 1000);
}

/**
 * Counts one finished campaign message (sent, or failed with no retry left) and closes the campaign
 * once every queued message is accounted for: completed if any were sent, failed if none were.
 */
export async function recordCampaignResult(
  businessId: Types.ObjectId,
  campaignId: Types.ObjectId,
  result: 'sent' | 'failed',
  costPaise = 0
): Promise<void> {
  const inc: Record<string, number> = { [`stats.${result}`]: 1 };
  if (costPaise) inc['stats.costPaise'] = costPaise;
  const campaign = await Campaign.findOneAndUpdate({ _id: campaignId, businessId }, { $inc: inc }, { new: true });
  // While messages are still being queued, stats.total is not final: nothing to close yet
  if (!campaign || campaign.status !== 'sending' || !campaign.queuedAt) return;
  const { total = 0, sent = 0, failed = 0 } = campaign.stats || ({} as any);
  if (total > 0 && sent + failed >= total) {
    // The status filter makes sure only one update closes it
    await Campaign.updateOne(
      { _id: campaignId, businessId, status: 'sending' },
      { $set: { status: sent === 0 ? 'failed' : 'completed' } }
    );
  }
}

/** A successful send proves the balance is fine again: clear the flag and tell the owner. */
export async function clearLowBalance(numberDoc: any): Promise<void> {
  if (!numberDoc?.lowBalance) return;
  numberDoc.lowBalance = false;
  await numberDoc.save();
  const owner = await User.findOne({ businessId: numberDoc.businessId, role: 'owner', status: 'active' });
  if (owner) {
    await Notification.create({
      businessId: numberDoc.businessId,
      userId: owner._id,
      type: 'wa_balance_restored',
      title: 'WhatsApp balance restored',
      body: 'Messages are going out again. Campaigns paused for low balance stay paused until you resume them.',
    });
  }
}

export function createWhatsAppWorker(): Worker {
  const connection = getBullConnection();

  const worker = new Worker(
    'whatsapp-send',
    async (job: Job<{ messageId: string }>) => {
      const { messageId } = job.data;
      logger.info({ jobId: job.id, messageId }, 'Processing whatsapp-send job');

      const message = await WaMessage.findById(messageId).setOptions({ skipTenantScope: true });
      if (!message) {
        logger.warn({ messageId }, 'WaMessage not found for job');
        return;
      }

      if (['sent', 'delivered', 'read'].includes(message.status)) {
        logger.info({ messageId, status: message.status }, 'WaMessage already processed, skipping');
        return;
      }

      // Campaign messages update their campaign's counters when they finish. A failure counts only
      // when no retry follows (permanent rejection, or BullMQ's last attempt).
      const isLastAttempt = (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
      const finish = async (result: 'sent' | 'failed', costPaise = 0, final = true) => {
        if (message.origin !== 'campaign' || !message.originId) return;
        if (result === 'failed' && !final) return;
        await recordCampaignResult(message.businessId, message.originId, result, costPaise).catch((err) =>
          logger.warn({ err, messageId }, 'Could not update campaign counters')
        );
      };

      const conversation = await WaConversation.findById(message.conversationId).setOptions({ skipTenantScope: true });
      if (!conversation) {
        logger.warn({ conversationId: message.conversationId }, 'Conversation not found for message');
        message.status = 'failed';
        message.error = 'Conversation not found';
        await message.save();
        await finish('failed');
        return;
      }

      const numberDoc = await WaNumber.findOne({
        _id: conversation.numberId,
        businessId: message.businessId,
        status: 'active',
      });

      if (!numberDoc) {
        logger.error({ businessId: message.businessId }, 'No active WaNumber found for business');
        message.status = 'failed';
        message.error = 'No active WhatsApp number configured';
        await message.save();
        await finish('failed');
        return;
      }

      const tokenEnc = numberDoc.instantBroadcast?.userTokenEnc || numberDoc.aisensy?.apiKeyEnc;
      const apiKey = tokenEnc ? decrypt(tokenEnc) : '';
      const uid = numberDoc.instantBroadcast?.uid || numberDoc.aisensy?.projectId;

      try {
        let templateName: string | undefined;
        if (message.templateId) {
          const tpl = await WaTemplate.findOne({ _id: message.templateId, businessId: message.businessId });
          // WhatsApp refuses templates that are not approved: fail it now with a clear reason
          if (!tpl || tpl.status !== 'approved') {
            message.status = 'failed';
            message.error = tpl ? `Template "${tpl.name}" is ${tpl.status}, not approved` : 'Template not found';
            await message.save();
            await finish('failed');
            return;
          }
          templateName = tpl.name;
        }

        const response = await sendInstantBroadcastMessage({
          apiKey,
          userToken: apiKey,
          uid,
          phone: conversation.phone,
          kind: message.kind,
          text: message.text,
          templateName,
          variables: message.variables,
          mediaUrl: message.mediaKey ? `https://storage.glox.io/${message.mediaKey}` : undefined,
        });

        if (response.lowBalance) {
          numberDoc.lowBalance = true;
          await numberDoc.save();
          await Campaign.updateMany(
            {
              businessId: message.businessId,
              numberId: numberDoc._id,
              status: { $in: ['scheduled', 'sending'] },
            },
            { $set: { status: 'paused' } }
          );
          const owner = await User.findOne({ businessId: message.businessId, role: 'owner', status: 'active' });
          if (owner) {
            await Notification.create({
              businessId: message.businessId,
              userId: owner._id,
              type: 'wa_low_balance',
              title: 'WhatsApp Balance Low',
              body: 'Your WhatsApp messaging balance is low. Active campaigns have been paused.',
            });
          }
        }

        // Rejected by Instant Broadcast or Meta: retrying would fail the same way
        if (!response.success) {
          message.status = 'failed';
          message.error = response.error || 'Rejected by Instant Broadcast';
          await message.save();
          logger.warn({ messageId, error: message.error }, 'WhatsApp message rejected by Instant Broadcast');
          await finish('failed');
          return;
        }

        message.status = 'sent';
        message.providerMessageId = response.providerMessageId || `ib_${Date.now()}`;
        message.costPaise = response.costPaise || 80;
        await message.save();
        if (!response.lowBalance) await clearLowBalance(numberDoc);
        await finish('sent', message.costPaise);

        logger.info({ messageId, providerMessageId: message.providerMessageId }, 'WhatsApp message sent successfully via Instant Broadcast');
      } catch (err: any) {
        logger.error({ err, messageId }, 'Failed to send WhatsApp message via Instant Broadcast');
        message.status = 'failed';
        message.error = err.message || 'Send error';
        await message.save();
        await finish('failed', 0, isLastAttempt);
        throw err; // retry with BullMQ
      }
    },
    { connection: connection as any, concurrency: 5 }
  );

  return worker;
}

async function resolveUploadedAudienceCustomerIds(businessId: Types.ObjectId, uploadKey: string): Promise<Types.ObjectId[]> {
  try {
    const buffer = await s3Adapter.getObject(uploadKey);
    if (!buffer || buffer.length === 0) return [];
    const phones: string[] = [];
    const textPreview = buffer.slice(0, 64).toString('utf8');
    if (textPreview.includes(',') || textPreview.includes('\n')) {
      for (const line of buffer.toString('utf8').split(/\r?\n/)) {
        const firstCol = line.split(',')[0]?.trim();
        if (!firstCol || /phone/i.test(firstCol)) continue;
        try {
          phones.push(normalizePhone(firstCol));
        } catch {
          // ignore invalid row
        }
      }
    } else {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as any);
      const sheet = workbook.worksheets[0];
      if (sheet) {
        sheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return;
          const raw = (row.values as any[])[1];
          if (!raw) return;
          try {
            phones.push(normalizePhone(String(raw)));
          } catch {
            // ignore invalid row
          }
        });
      }
    }
    if (phones.length === 0) return [];
    return Customer.find({
      businessId,
      phone: { $in: phones },
      doNotMessage: { $ne: true },
      waOptIn: { $ne: false },
    }).distinct('_id');
  } catch (err) {
    logger.warn({ err, uploadKey }, 'Failed to resolve uploaded campaign audience');
    return [];
  }
}

export function createCampaignWorker(): Worker {
  const connection = getBullConnection();

  return new Worker(
    'campaign-send',
    async (job: Job<{ campaignId: string; businessId: string }>) => {
      const { campaignId, businessId } = job.data;
      const bId = toObjectId(businessId);
      const cId = toObjectId(campaignId);

      const campaign = await Campaign.findOne({ _id: cId, businessId: bId });
      if (!campaign || ['completed', 'cancelled', 'paused'].includes(campaign.status)) {
        return;
      }

      // Pause if number is missing or flagged for low balance
      const campaignNumber = await WaNumber.findOne({ _id: campaign.numberId, businessId: bId, status: 'active' });
      if (!campaignNumber || campaignNumber.lowBalance) {
        campaign.status = 'paused';
        await campaign.save();
        return;
      }

      const business = await Business.findById(bId);
      const now = new Date();
      if (isQuietHoursIst(business?.automationGuards, now)) {
        const delayMs = msUntilQuietEndIst(business?.automationGuards, now);
        logger.info({ campaignId, delayMs }, 'Campaign send deferred due to quiet hours (IST)');
        campaign.status = 'scheduled';
        await campaign.save();
        try {
          await campaignSendQueue().add(
            'send',
            { campaignId: campaign._id.toString(), businessId: bId.toString() },
            { delay: delayMs, jobId: `campaign:${campaign._id}:resume:${Date.now()}` }
          );
        } catch (err) {
          logger.warn({ err, campaignId }, 'Could not re-queue campaign after quiet hours');
        }
        return;
      }

      campaign.status = 'sending';
      campaign.queuedAt = undefined; // set again once every message of this run is queued
      await campaign.save();

      // Load linked offer if exists
      let offer: any = null;
      if (campaign.offerId) {
        offer = await MarketingOffer.findOne({ _id: campaign.offerId, businessId: bId });
      }

      // Resolve target audience customers
      let customerIds: Types.ObjectId[] = [];
      if (campaign.audience?.kind === 'segment') {
        let criteria = campaign.audience.segmentCriteria;
        if (campaign.audience.segmentId) {
          const seg = await MarketingSegment.findOne({ _id: campaign.audience.segmentId, businessId: bId });
          if (seg) criteria = seg.criteria;
        }
        if (criteria) {
          customerIds = await segmentationService.resolveEligibleCustomerIds(bId, criteria);
        } else {
          customerIds = await Customer.find({
            businessId: bId,
            doNotMessage: { $ne: true },
            waOptIn: { $ne: false },
          }).distinct('_id');
        }
        const unticked = new Set((campaign.audience.excludeCustomerIds || []).map((id) => id.toString()));
        if (unticked.size) customerIds = customerIds.filter((id) => !unticked.has(id.toString()));
      } else if (campaign.audience?.kind === 'selection' && campaign.audience.customerIds) {
        customerIds = await Customer.find({
          _id: { $in: campaign.audience.customerIds },
          businessId: bId,
          doNotMessage: { $ne: true },
          waOptIn: { $ne: false },
        }).distinct('_id');
      } else if (campaign.audience?.kind === 'upload' && campaign.audience.uploadKey) {
        customerIds = await resolveUploadedAudienceCustomerIds(bId, campaign.audience.uploadKey);
      }

      const customers = await Customer.find({
        _id: { $in: customerIds },
        businessId: bId,
        phone: { $exists: true, $ne: '' },
      }).limit(5000);

      const todayIst = getBusinessDate(now);
      const maxMarketingPerDay = business?.automationGuards?.maxMarketingPerDay ?? 1;
      let count = 0;

      for (const cust of customers) {
        if (!cust.phone) continue;

        // Respect pause if owner paused mid-run
        const latestCampaign = await Campaign.findOne({ _id: cId, businessId: bId }).select('status');
        if (!latestCampaign || latestCampaign.status === 'paused' || latestCampaign.status === 'cancelled') {
          return;
        }

        // Campaign dedupe
        const dedupeKey = `mkt:${cId}:${cust._id}`;
        const alreadySent = await AutomationSend.findById(dedupeKey);
        if (alreadySent) continue;

        // Business-wide daily marketing cap guard
        const dailyCapCount = await AutomationSend.countDocuments({
          businessId: bId,
          _id: { $regex: `^mktcap:${cust._id}:${todayIst}:` },
        });
        if (dailyCapCount >= maxMarketingPerDay) continue;

        // Upsert conversation
        let conversation = await WaConversation.findOne({
          businessId: bId,
          numberId: campaign.numberId,
          phone: cust.phone,
        });

        if (!conversation) {
          const branchId = await defaultChatBranchId(bId, campaignNumber ?? {});
          conversation = await WaConversation.create({
            businessId: bId,
            numberId: campaign.numberId,
            branchId,
            phone: cust.phone,
            customerId: cust._id,
            lastMessageAt: new Date(),
            unread: 0,
          });
        }

        // Variable replacement
        const templateVars: string[] = [];
        const rawMap = campaign.variableMap || {};
        const varKeys = Object.keys(rawMap);

        if (varKeys.length > 0) {
          for (const k of varKeys) {
            let val = rawMap[k] || '';
            val = val
              .replace(/{{customer_name}}/gi, cust.name || 'Valued Customer')
              .replace(/{{offer_code}}/gi, offer?.code || '')
              .replace(
                /{{discount_value}}/gi,
                offer
                  ? offer.discountType === 'percentage'
                    ? `${offer.discountValue / 100}%`
                    : `₹${(offer.discountValue / 100).toFixed(0)}`
                  : ''
              )
              .replace(/{{expiry_date}}/gi, offer ? offer.validTill.toISOString().split('T')[0] : '');
            templateVars.push(val);
          }
        }

        const msg = await WaMessage.create({
          businessId: bId,
          conversationId: conversation._id,
          direction: 'out',
          kind: 'template',
          templateId: campaign.templateId,
          variables: templateVars.length > 0 ? templateVars : undefined,
          origin: 'campaign',
          originId: campaign._id,
          status: 'queued',
        });

        await AutomationSend.create({
          _id: dedupeKey,
          businessId: bId,
          messageId: msg._id,
          at: new Date(),
        });
        await AutomationSend.create({
          _id: `mktcap:${cust._id}:${todayIst}:${msg._id}`,
          businessId: bId,
          messageId: msg._id,
          at: new Date(),
        });

        await whatsappSendQueue().add(
          'send',
          { messageId: msg._id.toString() },
          { jobId: msg._id.toString() }
        );
        count++;
      }

      // stats.total held the audience estimate from creation; it is now the real number of messages
      // created for this campaign (all runs, so a resumed campaign counts its earlier ones too).
      // The campaign stays "sending" until each message is sent or finally fails (see
      // recordCampaignResult); queuedAt marks that queuing is finished. Atomic update: the send
      // worker may already be counting results.
      const totalMessages = await WaMessage.countDocuments({ businessId: bId, origin: 'campaign', originId: cId });
      const updated = await Campaign.findOneAndUpdate(
        { _id: cId, businessId: bId },
        { $set: { 'stats.total': totalMessages, queuedAt: new Date() } },
        { new: true }
      );
      if (updated && updated.status === 'sending') {
        const { sent = 0, failed = 0 } = updated.stats || ({} as any);
        if (totalMessages === 0 || sent + failed >= totalMessages) {
          await Campaign.updateOne(
            { _id: cId, businessId: bId, status: 'sending' },
            { $set: { status: totalMessages > 0 && sent > 0 ? 'completed' : 'failed' } }
          );
        }
      }
      logger.info({ campaignId, queued: count, totalMessages }, 'Campaign messages queued');
    },
    { connection: connection as any, concurrency: 2 }
  );
}

export function createTemplateSyncWorker(): Worker {
  const connection = getBullConnection();

  return new Worker(
    'template-sync',
    async (job: Job<{ numberId: string; businessId: string }>) => {
      const { numberId, businessId } = job.data;
      const bId = toObjectId(businessId);
      const nId = toObjectId(numberId);

      const numberDoc = await WaNumber.findOne({ _id: nId, businessId: bId });
      if (!numberDoc) return;

      const tokenEnc = numberDoc.instantBroadcast?.userTokenEnc || numberDoc.aisensy?.apiKeyEnc;
      const apiKey = tokenEnc ? decrypt(tokenEnc) : '';
      const uid = numberDoc.instantBroadcast?.uid || numberDoc.aisensy?.projectId;
      const templates = await fetchInstantBroadcastTemplates(apiKey, uid);

      for (const tpl of templates) {
        await WaTemplate.findOneAndUpdate(
          { businessId: bId, numberId: nId, name: tpl.name },
          {
            businessId: bId,
            numberId: nId,
            name: tpl.name,
            category: tpl.category || 'marketing',
            language: tpl.language || 'en',
            status: tpl.status || 'approved',
            body: tpl.body || '',
            variables: tpl.variables || [],
            syncedAt: new Date(),
          },
          { upsert: true }
        );
      }
    },
    { connection: connection as any, concurrency: 2 }
  );
}
