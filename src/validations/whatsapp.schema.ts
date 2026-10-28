import { z } from 'zod';
import { objectIdSchema } from './common.schema';

export const configureWaNumberSchema = z.object({
  phone: z.string().min(10, 'Valid WhatsApp phone is required'),
  apiKey: z.string().min(1, 'AiSensy API key is required'),
  projectId: z.string().min(1, 'AiSensy project ID is required'),
  webhookSecret: z.string().optional().default('default-webhook-secret'),
  branchIds: z.array(objectIdSchema).optional(),
});

export const sendWaMessageSchema = z.object({
  text: z.string().min(1).optional(),
  templateId: objectIdSchema.optional(),
  variables: z.array(z.string()).optional(),
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
