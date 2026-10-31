import { Router } from 'express';
import { guardedRouter } from './guarded-router';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole, requireKind } from '../middlewares/role.middleware';
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

// Authenticated WhatsApp endpoints (guards run only for these routes, not for other routers' paths)
const whatsappAuthed = guardedRouter(authenticate(), requireKind('tenant'));
whatsappRouter.use(whatsappAuthed);

// 3. Shared Inbox & Conversations
whatsappAuthed.get('/whatsapp/conversations', WhatsappController.getConversations);
whatsappAuthed.get('/whatsapp/conversations/:id', WhatsappController.getConversationById);
whatsappAuthed.get('/whatsapp/messages', WhatsappController.getMessages);
whatsappAuthed.post('/whatsapp/messages', validate({ body: sendWaMessageSchema }), WhatsappController.sendMessage);

// 4. Templates
whatsappAuthed.get('/whatsapp/templates', WhatsappController.getTemplates);
whatsappAuthed.post('/whatsapp/templates/sync', requireRole('owner'), WhatsappController.syncTemplates);

// 5. Campaigns
whatsappAuthed.post('/whatsapp/campaigns', requireRole('owner', 'manager'), validate({ body: createWaCampaignSchema }), WhatsappController.createCampaign);
whatsappAuthed.get('/whatsapp/campaigns', WhatsappController.getCampaigns);

// 6. Automations
whatsappAuthed.get('/whatsapp/automations', WhatsappController.getAutomations);
whatsappAuthed.patch('/whatsapp/automations/:key', requireRole('owner', 'manager'), validate({ body: updateWaAutomationSchema }), WhatsappController.updateAutomation);
