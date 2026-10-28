import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IRosterWeekly {
  day: number;
  start?: string;
  end?: string;
  off: boolean;
}

export interface IRosterOverride {
  date: string;
  start?: string;
  end?: string;
  off: boolean;
}

export interface IRoster extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  staffId: Types.ObjectId;
  weekly: IRosterWeekly[];
  overrides: IRosterOverride[];
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const rosterSchema = new Schema<IRoster>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    staffId: { type: Schema.Types.ObjectId, ref: 'staff', required: true },
    weekly: [
      {
        day: { type: Number, min: 0, max: 6, required: true },
        start: { type: String },
        end: { type: String },
        off: { type: Boolean, required: true, default: false },
      },
    ],
    overrides: [
      {
        date: { type: String, required: true },
        start: { type: String },
        end: { type: String },
        off: { type: Boolean, required: true, default: false },
      },
    ],
  },
  {
    collection: 'rosters',
  }
);

rosterSchema.plugin(baseFieldsPlugin);
rosterSchema.plugin(tenantScopePlugin);

rosterSchema.index({ businessId: 1, staffId: 1 }, { unique: true });

export const Roster = model<IRoster>('rosters', rosterSchema);
