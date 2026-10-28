import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface ILead extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  name?: string;
  phone: string;
  source: 'whatsapp' | 'walk_in' | 'phone';
  serviceIds: Types.ObjectId[];
  budgetPaise?: number;
  stage: 'new' | 'contacted' | 'interested' | 'booked' | 'lost';
  lostReason?: string;
  assignedTo?: Types.ObjectId;
  followUpDate?: string;
  notes?: string;
  conversationId?: Types.ObjectId;
  customerId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const leadSchema = new Schema<ILead>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    name: { type: String },
    phone: { type: String, required: true },
    source: { type: String, enum: ['whatsapp', 'walk_in', 'phone'], default: 'phone', required: true },
    serviceIds: [{ type: Schema.Types.ObjectId, ref: 'services' }],
    budgetPaise: { type: Number },
    stage: { type: String, enum: ['new', 'contacted', 'interested', 'booked', 'lost'], default: 'new', required: true },
    lostReason: { type: String },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'users' },
    followUpDate: { type: String },
    notes: { type: String },
    conversationId: { type: Schema.Types.ObjectId, ref: 'waConversations' },
    customerId: { type: Schema.Types.ObjectId, ref: 'customers' },
  },
  {
    collection: 'leads',
  }
);

leadSchema.plugin(baseFieldsPlugin);
leadSchema.plugin(tenantScopePlugin);

leadSchema.index({ businessId: 1, branchId: 1, stage: 1 });
leadSchema.index({ businessId: 1, followUpDate: 1 });

export const Lead = model<ILead>('leads', leadSchema);
