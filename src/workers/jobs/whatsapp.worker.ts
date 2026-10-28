import { Worker, Job } from 'bullmq';
import { getBullConnection, sendAiSensyMessage, fetchAiSensyTemplates } from '../../integrations';
import {
  WaMessage,
  WaNumber,
  WaTemplate,
  WaConversation,
  Campaign,
  Customer,
} from '../../models';
import { logger, decrypt } from '../../utils';
import { toObjectId } from '../../services';
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

      const apiKey = decrypt(numberDoc.aisensy.apiKeyEnc);

      try {
        let templateName: string | undefined;
        if (message.templateId) {
          const tpl = await WaTemplate.findById(message.templateId);
          if (tpl) templateName = tpl.name;
        }

        const response = await sendAiSensyMessage({
          apiKey,
          phone: conversation.phone,
          kind: message.kind,
          text: message.text,
          templateName,
          variables: message.variables,
          mediaUrl: message.mediaKey ? `https://storage.glox.io/${message.mediaKey}` : undefined,
        });

        message.status = 'sent';
        message.providerMessageId = response.providerMessageId || `aisensy_${Date.now()}`;
        message.costPaise = response.costPaise || 80;
        await message.save();

        logger.info({ messageId, providerMessageId: message.providerMessageId }, 'WhatsApp message sent successfully');
      } catch (err: any) {
        logger.error({ err, messageId }, 'Failed to send WhatsApp message via AiSensy');
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

      // Find target audience
      const customerFilter: any = { businessId: bId, doNotMessage: { $ne: true } };
      const segment = campaign.audience?.segment;
      if (segment && typeof segment === 'object') {
        if (segment.type === 'vip') {
          customerFilter.tags = 'VIP';
        } else if (segment.type === 'lapsed') {
          const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
          customerFilter['stats.lastVisit'] = { $lt: sixtyDaysAgo };
        }
      }

      const customers = await Customer.find(customerFilter).limit(5000);
      let count = 0;

      for (const cust of customers) {
        if (!cust.phone) continue;

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

        const msg = await WaMessage.create({
          businessId: bId,
          conversationId: conversation._id,
          direction: 'out',
          kind: 'template',
          templateId: campaign.templateId,
          origin: 'campaign',
          originId: campaign._id,
          status: 'queued',
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

      const apiKey = decrypt(numberDoc.aisensy.apiKeyEnc);
      const templates = await fetchAiSensyTemplates(apiKey);

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
