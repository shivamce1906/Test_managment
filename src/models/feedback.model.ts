import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IFeedback extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  billId: Types.ObjectId;
  customerId: Types.ObjectId;
  staffIds: Types.ObjectId[];
  rating: 1 | 2 | 3 | 4 | 5;
  comment?: string;
  reviewLinkSent: boolean;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const feedbackSchema = new Schema<IFeedback>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    billId: { type: Schema.Types.ObjectId, ref: 'bills', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'customers', required: true },
    staffIds: [{ type: Schema.Types.ObjectId, ref: 'staff' }],
    rating: { type: Number, enum: [1, 2, 3, 4, 5], required: true },
    comment: { type: String },
    reviewLinkSent: { type: Boolean, default: false, required: true },
  },
  {
    collection: 'feedback',
  }
);

feedbackSchema.plugin(baseFieldsPlugin);
feedbackSchema.plugin(tenantScopePlugin);

feedbackSchema.index({ businessId: 1, branchId: 1, createdAt: -1 });
feedbackSchema.index({ businessId: 1, billId: 1 }, { unique: true });

export const Feedback = model<IFeedback>('feedback', feedbackSchema);
