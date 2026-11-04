import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export type LeadFollowUpChannel = 'call' | 'whatsapp' | 'visit' | 'other';
export type LeadFollowUpOutcome = 'no_answer' | 'call_back' | 'interested' | 'not_interested' | 'booked' | 'other';

export interface ILeadFollowUp {
  _id: Types.ObjectId;
  /** 1 = 1st follow-up, 2 = 2nd … */
  number: number;
  at: Date;
  channel: LeadFollowUpChannel;
  outcome: LeadFollowUpOutcome;
  note?: string;
  nextFollowUpDate?: string;
  by: Types.ObjectId;
}

export interface ILeadNote {
  _id: Types.ObjectId;
  text: string;
  at: Date;
  by: Types.ObjectId;
  /** Set when the note was written with a follow-up */
  followUpNumber?: number;
}

export interface ILead extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  name?: string;
  phone: string;
  email?: string;
  gender?: 'male' | 'female' | 'other';
  dob?: string;
  anniversary?: string;
  address?: { line1?: string; line2?: string; city?: string; state?: string; pincode?: string };
  source: 'whatsapp' | 'walk_in' | 'phone';
  serviceIds: Types.ObjectId[];
  budgetPaise?: number;
  stage: 'new' | 'contacted' | 'interested' | 'booked' | 'lost';
  lostReason?: string;
  assignedTo?: Types.ObjectId;
  /** Next follow-up due (YYYY-MM-DD) */
  followUpDate?: string;
  followUps: ILeadFollowUp[];
  noteLog: ILeadNote[];
  /** Legacy single note; new notes go to noteLog */
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
    email: { type: String },
    gender: { type: String, enum: ['male', 'female', 'other'] },
    dob: { type: String },
    anniversary: { type: String },
    address: {
      line1: { type: String },
      line2: { type: String },
      city: { type: String },
      state: { type: String },
      pincode: { type: String },
    },
    source: { type: String, enum: ['whatsapp', 'walk_in', 'phone'], default: 'phone', required: true },
    serviceIds: [{ type: Schema.Types.ObjectId, ref: 'services' }],
    budgetPaise: { type: Number },
    stage: { type: String, enum: ['new', 'contacted', 'interested', 'booked', 'lost'], default: 'new', required: true },
    lostReason: { type: String },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'users' },
    followUpDate: { type: String },
    followUps: [
      {
        number: { type: Number, required: true },
        at: { type: Date, required: true },
        channel: { type: String, enum: ['call', 'whatsapp', 'visit', 'other'], required: true },
        outcome: { type: String, enum: ['no_answer', 'call_back', 'interested', 'not_interested', 'booked', 'other'], required: true },
        note: { type: String },
        nextFollowUpDate: { type: String },
        by: { type: Schema.Types.ObjectId, ref: 'users', required: true },
      },
    ],
    noteLog: [
      {
        text: { type: String, required: true },
        at: { type: Date, required: true },
        by: { type: Schema.Types.ObjectId, ref: 'users', required: true },
        followUpNumber: { type: Number },
      },
    ],
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
