import { Schema, model, Document } from 'mongoose';

export interface ICounter extends Document<string> {
  _id: string; // `${businessId}:${branchId}:${kind}:${fy}` or `${businessId}:${staffId}:slotlock:${businessDate}`
  seq: number;
}

const counterSchema = new Schema<ICounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0, required: true },
  },
  {
    collection: 'counters',
    _id: false,
    timestamps: true,
  }
);

export const Counter = model<ICounter>('counters', counterSchema);
