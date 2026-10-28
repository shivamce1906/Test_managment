import { Schema, model, Document, Types } from 'mongoose';

export interface IChangeCursor extends Document<string> {
  _id: string; // `${businessId}:${branchId}:${scope}`
  businessId: Types.ObjectId;
  scope: string;
  cursor: number;
  updatedAt: Date;
}

const changeCursorSchema = new Schema<IChangeCursor>(
  {
    _id: { type: String, required: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'businesses', required: true },
    scope: { type: String, required: true },
    cursor: { type: Number, default: 0, required: true },
  },
  {
    collection: 'changeCursors',
    _id: false,
    timestamps: { createdAt: false, updatedAt: true },
  }
);

export const ChangeCursor = model<IChangeCursor>('changeCursors', changeCursorSchema);
