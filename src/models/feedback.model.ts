import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IFeedback extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  billId?: Types.ObjectId;
  appointmentId?: Types.ObjectId;
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
    billId: { type: Schema.Types.ObjectId, ref: 'bills' },
    appointmentId: { type: Schema.Types.ObjectId, ref: 'appointments' },
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
// One feedback per bill and per appointment. "sparse" does not work on a compound index whose first
// field (businessId) is always present: every feedback without a bill (or without an appointment)
// collided with the first one. Partial indexes only cover feedback that has the field.
feedbackSchema.index(
  { businessId: 1, billId: 1 },
  { unique: true, partialFilterExpression: { billId: { $exists: true } }, name: 'businessId_1_billId_1_partial' }
);
feedbackSchema.index(
  { businessId: 1, appointmentId: 1 },
  { unique: true, partialFilterExpression: { appointmentId: { $exists: true } }, name: 'businessId_1_appointmentId_1_partial' }
);

export const Feedback = model<IFeedback>('feedback', feedbackSchema);
