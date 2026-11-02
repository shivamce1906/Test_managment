import { Worker, Job } from 'bullmq';
import { Types } from 'mongoose';
import { getBullConnection, sendInstantBroadcastMessage, fetchInstantBroadcastTemplates } from '../../integrations';
import {
  WaMessage,
  WaNumber,
  WaTemplate,
  WaConversation,
  Campaign,
  Customer,
  MarketingOffer,
  MarketingSegment,
  AutomationSend,
} from '../../models';
import { logger, decrypt } from '../../utils';
import { toObjectId } from '../../services';
import { segmentationService } from '../../services/segmentation.service';
import { whatsappSendQueue } from '../queues';

export function createWhatsAppWorker(): Worker {
  const connection = getBullConnection();

  const worker = new Worker(
    'whatsapp-send',
    async (job: Job<{ messageId: string }>) => {
      const { messageId } = job.data;
      logger.info({ jobId: job.id, messageId }, 'Processing whatsapp-send job');

      const message = await WaMessage.findById(messageId);
      if (!message) {
        logger.warn({ messageId }, 'WaMessage not found for job');
        return;
      }

      if (['sent', 'delivered', 'read'].includes(message.status)) {
        logger.info({ messageId, status: message.status }, 'WaMessage already processed, skipping');
        return;
      }

      const conversation = await WaConversation.findById(message.conversationId);
      if (!conversation) {
        logger.warn({ conversationId: message.conversationId }, 'Conversation not found for message');
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
        return;
      }

      const tokenEnc = numberDoc.instantBroadcast?.userTokenEnc || numberDoc.aisensy?.apiKeyEnc;
      const apiKey = tokenEnc ? decrypt(tokenEnc) : '';
      const uid = numberDoc.instantBroadcast?.uid || numberDoc.aisensy?.projectId;

      try {
        let templateName: string | undefined;
        if (message.templateId) {
          const tpl = await WaTemplate.findById(message.templateId);
          if (tpl) templateName = tpl.name;
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

        message.status = 'sent';
        message.providerMessageId = response.providerMessageId || `ib_${Date.now()}`;
        message.costPaise = response.costPaise || 80;
        await message.save();

        logger.info({ messageId, providerMessageId: message.providerMessageId }, 'WhatsApp message sent successfully via Instant Broadcast');
      } catch (err: any) {
        logger.error({ err, messageId }, 'Failed to send WhatsApp message via Instant Broadcast');
        message.status = 'failed';
        message.error = err.message || 'Send error';
        await message.save();
        throw err; // retry with BullMQ
      }
    },
    { connection: connection as any, concurrency: 5 }
  );

  return worker;
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
      if (!campaign || campaign.status === 'completed' || campaign.status === 'cancelled') {
        return;
      }

      campaign.status = 'sending';
      await campaign.save();

      // Check quiet hours (allowed 09:00 - 21:00 IST)
      const now = new Date();
      const istHours = new Date(now.getTime() + 5.5 * 60 * 60 * 1000).getUTCHours();
      if (istHours < 9 || istHours >= 21) {
        logger.info({ campaignId, istHours }, 'Campaign send deferred due to quiet hours (09:00-21:00 IST)');
        // Calculate delay until 09:00 IST
        campaign.status = 'scheduled';
        await campaign.save();
        return;
      }

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
      } else if (campaign.audience?.kind === 'selection' && campaign.audience.customerIds) {
        customerIds = await Customer.find({
          _id: { $in: campaign.audience.customerIds },
          businessId: bId,
          doNotMessage: { $ne: true },
          waOptIn: { $ne: false },
        }).distinct('_id');
      }

      const customers = await Customer.find({
        _id: { $in: customerIds },
        businessId: bId,
        phone: { $exists: true, $ne: '' },
      }).limit(5000);

      let count = 0;

      for (const cust of customers) {
        if (!cust.phone) continue;

        // Daily marketing cap guard (max 1 marketing message per customer per day)
        const dedupeKey = `mkt:${cId}:${cust._id}`;
        const alreadySent = await AutomationSend.findById(dedupeKey);
        if (alreadySent) continue;

        // Upsert conversation
        let conversation = await WaConversation.findOne({
          businessId: bId,
          numberId: campaign.numberId,
          phone: cust.phone,
        });

        if (!conversation) {
          const branchId = toObjectId(cust.businessId);
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

        await whatsappSendQueue().add(
          'send',
          { messageId: msg._id.toString() },
          { jobId: msg._id.toString() }
        );
        count++;
      }

      campaign.status = 'completed';
      campaign.stats = campaign.stats || {
        total: count,
        excluded: 0,
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
        costPaise: 0,
      };
      campaign.stats.sent = count;
      await campaign.save();
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
