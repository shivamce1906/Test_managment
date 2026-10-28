import { Schema, model, Document, Types } from 'mongoose';

export interface IEmailRegistry extends Document<string> {
  _id: string; // Lowercased normalized email
  kind: 'platform' | 'tenant';
  businessId?: Types.ObjectId;
  userId: Types.ObjectId;
}

const emailRegistrySchema = new Schema<IEmailRegistry>(
  {
    _id: { type: String, required: true },
    kind: { type: String, enum: ['platform', 'tenant'], required: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'businesses' },
    userId: { type: Schema.Types.ObjectId, required: true },
  },
  {
    collection: 'emailRegistry',
    _id: false,
    timestamps: true,
  }
);

export const EmailRegistry = model<IEmailRegistry>('emailRegistry', emailRegistrySchema);
