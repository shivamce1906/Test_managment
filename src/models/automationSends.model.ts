import { Schema, model, Document, Types } from 'mongoose';

export interface IAutomationSend extends Document<string> {
  _id: string; // `${key}:${refId}:${period}`
  businessId: Types.ObjectId;
  messageId: Types.ObjectId;
  at: Date;
}

const automationSendSchema = new Schema<IAutomationSend>(
  {
    _id: { type: String, required: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'businesses', required: true },
    messageId: { type: Schema.Types.ObjectId, ref: 'waMessages', required: true },
    at: { type: Date, default: Date.now, required: true },
  },
  {
    collection: 'automationSends',
    _id: false,
    timestamps: false,
  }
);

export const AutomationSend = model<IAutomationSend>('automationSends', automationSendSchema);
