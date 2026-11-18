import { z } from 'zod';
import { objectIdSchema } from './common.schema';

export const configureWaNumberSchema = z.object({
  phone: z.string().min(10, 'Valid WhatsApp phone is required'),
  uid: z.string().optional(),
  userToken: z.string().optional(),
  apiKey: z.string().optional(),
  projectId: z.string().optional(),
  webhookSecret: z.string().min(16, 'Use at least 16 characters').optional(),
  branchIds: z.array(objectIdSchema).optional(),
});

export const saveChatNoteSchema = z.object({
  note: z.string().min(1, 'Note cannot be empty'),
});

export const markChatReadSchema = z.object({
  chatId: z.string().optional(),
});

export const sendWaMessageSchema = z.object({
  conversationId: objectIdSchema.optional(),
  text: z.string().min(1).optional(),
  templateId: objectIdSchema.optional(),
  variables: z.array(z.string()).optional(),
  scheduledAt: z.string().datetime().optional(),
}).refine((data) => data.text || data.templateId, {
  message: 'Either text or templateId must be provided',
});

export const createCampaignSchema = z.object({
  name: z.string().min(1, 'Campaign name is required'),
  numberId: objectIdSchema,
  templateId: objectIdSchema,
  audience: z.object({
    kind: z.enum(['segment', 'upload', 'selection']),
    segment: z.record(z.any()).optional(),
    customerIds: z.array(objectIdSchema).optional(),
    uploadKey: z.string().optional(),
  }),
  variableMap: z.record(z.string()).default({}),
  scheduledAt: z.string().datetime().optional(),
});
export const createWaCampaignSchema = createCampaignSchema;

export const updateAutomationSchema = z.object({
  enabled: z.boolean(),
  templateId: objectIdSchema.optional(),
  settings: z.record(z.any()).optional(),
});
export const updateWaAutomationSchema = updateAutomationSchema;


export const submitFeedbackSchema = z.object({
  branchId: objectIdSchema,
  billId: objectIdSchema,
  customerId: objectIdSchema,
  staffIds: z.array(objectIdSchema).default([]),
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  comment: z.string().optional(),
});
