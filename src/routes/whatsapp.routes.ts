import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/role.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  sendWaMessageSchema,
  createWaCampaignSchema,
  updateWaAutomationSchema,
  submitFeedbackSchema,
} from '../validations';
import { WhatsappController } from '../controllers/whatsapp.controller';

export const whatsappRouter = Router();

// 1. Inbound Webhook from AiSensy (Public, verified via numberId lookup)
whatsappRouter.post('/webhooks/aisensy/:numberId', WhatsappController.processWebhook);

// 2. Feedback submission endpoint
whatsappRouter.post('/whatsapp/feedback', authenticate(), validate({ body: submitFeedbackSchema }), WhatsappController.submitFeedback);

// Authenticated WhatsApp endpoints
whatsappRouter.use(authenticate());

// 3. Shared Inbox & Conversations
whatsappRouter.get('/whatsapp/conversations', WhatsappController.getConversations);
whatsappRouter.get('/whatsapp/conversations/:id', WhatsappController.getConversationById);
whatsappRouter.get('/whatsapp/messages', WhatsappController.getMessages);
whatsappRouter.post('/whatsapp/messages', validate({ body: sendWaMessageSchema }), WhatsappController.sendMessage);

// 4. Templates
whatsappRouter.get('/whatsapp/templates', WhatsappController.getTemplates);
whatsappRouter.post('/whatsapp/templates/sync', requireRole('owner'), WhatsappController.syncTemplates);

// 5. Campaigns
whatsappRouter.post('/whatsapp/campaigns', requireRole('owner', 'manager'), validate({ body: createWaCampaignSchema }), WhatsappController.createCampaign);
whatsappRouter.get('/whatsapp/campaigns', WhatsappController.getCampaigns);

// 6. Automations
whatsappRouter.get('/whatsapp/automations', WhatsappController.getAutomations);
whatsappRouter.patch('/whatsapp/automations/:key', requireRole('owner', 'manager'), validate({ body: updateWaAutomationSchema }), WhatsappController.updateAutomation);
