import { Schema, model, Document, Types } from 'mongoose';

export interface IWebhookEvent extends Document {
  numberId: Types.ObjectId;
  payload: Record<string, any>;
  processedAt?: Date;
  receivedAt: Date;
}

const webhookEventSchema = new Schema<IWebhookEvent>(
  {
    numberId: { type: Schema.Types.ObjectId, ref: 'waNumbers', required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    processedAt: { type: Date },
    receivedAt: { type: Date, default: Date.now, required: true },
  },
  {
    collection: 'webhookEvents',
    timestamps: false,
  }
);

// TTL index to automatically delete raw webhook events after 7 days
webhookEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export const WebhookEvent = model<IWebhookEvent>('webhookEvents', webhookEventSchema);
