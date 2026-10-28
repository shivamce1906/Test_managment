import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IWaConversation extends Document {
  businessId: Types.ObjectId;
  numberId: Types.ObjectId;
  branchId: Types.ObjectId;
  phone: string;
  customerId?: Types.ObjectId;
  leadId?: Types.ObjectId;
  lastMessageAt: Date;
  lastInboundAt?: Date;
  unread: number;
  assignedTo?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const waConversationSchema = new Schema<IWaConversation>(
  {
    numberId: { type: Schema.Types.ObjectId, ref: 'waNumbers', required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    phone: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'customers' },
    leadId: { type: Schema.Types.ObjectId, ref: 'leads' },
    lastMessageAt: { type: Date, default: Date.now, required: true },
    lastInboundAt: { type: Date },
    unread: { type: Number, default: 0, required: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'users' },
  },
  {
    collection: 'waConversations',
  }
);

waConversationSchema.plugin(baseFieldsPlugin);
waConversationSchema.plugin(tenantScopePlugin);

waConversationSchema.index({ businessId: 1, numberId: 1, phone: 1 }, { unique: true });
waConversationSchema.index({ businessId: 1, branchId: 1, lastMessageAt: -1 });

export const WaConversation = model<IWaConversation>('waConversations', waConversationSchema);
