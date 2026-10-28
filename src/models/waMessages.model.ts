import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IWaMessage extends Document {
  businessId: Types.ObjectId;
  conversationId: Types.ObjectId;
  direction: 'in' | 'out';
  providerMessageId?: string;
  kind: 'text' | 'template' | 'media';
  text?: string;
  templateId?: Types.ObjectId;
  variables?: string[];
  mediaKey?: string;
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
  error?: string;
  costPaise?: number;
  origin: 'inbox' | 'campaign' | 'automation' | 'transactional';
  originId?: Types.ObjectId;
  sentBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const waMessageSchema = new Schema<IWaMessage>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'waConversations', required: true },
    direction: { type: String, enum: ['in', 'out'], required: true },
    providerMessageId: { type: String },
    kind: { type: String, enum: ['text', 'template', 'media'], required: true },
    text: { type: String },
    templateId: { type: Schema.Types.ObjectId, ref: 'waTemplates' },
    variables: [{ type: String }],
    mediaKey: { type: String },
    status: {
      type: String,
      enum: ['queued', 'sent', 'delivered', 'read', 'failed'],
      default: 'queued',
      required: true,
    },
    error: { type: String },
    costPaise: { type: Number, default: 0 },
    origin: {
      type: String,
      enum: ['inbox', 'campaign', 'automation', 'transactional'],
      default: 'inbox',
      required: true,
    },
    originId: { type: Schema.Types.ObjectId },
    sentBy: { type: Schema.Types.ObjectId, ref: 'users' },
  },
  {
    collection: 'waMessages',
  }
);

waMessageSchema.plugin(baseFieldsPlugin);
waMessageSchema.plugin(tenantScopePlugin);

waMessageSchema.index({ conversationId: 1, createdAt: -1 });
waMessageSchema.index({ providerMessageId: 1 }, { unique: true, sparse: true });

export const WaMessage = model<IWaMessage>('waMessages', waMessageSchema);
