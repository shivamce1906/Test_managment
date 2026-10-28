import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IAttendanceEdit {
  by: Types.ObjectId;
  at: Date;
  reason: string;
  before: Record<string, any>;
}

export interface IAttendance extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  staffId: Types.ObjectId;
  businessDate: string;
  status: 'present' | 'late' | 'half_day' | 'absent' | 'leave' | 'week_off' | 'holiday';
  inAt?: Date;
  outAt?: Date;
  overtimeMin: number;
  note?: string;
  markedBy: Types.ObjectId;
  edits: IAttendanceEdit[];
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const attendanceSchema = new Schema<IAttendance>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    staffId: { type: Schema.Types.ObjectId, ref: 'staff', required: true },
    businessDate: { type: String, required: true },
    status: {
      type: String,
      enum: ['present', 'late', 'half_day', 'absent', 'leave', 'week_off', 'holiday'],
      required: true,
    },
    inAt: { type: Date },
    outAt: { type: Date },
    overtimeMin: { type: Number, default: 0, required: true },
    note: { type: String },
    markedBy: { type: Schema.Types.ObjectId, ref: 'users', required: true },
    edits: [
      {
        by: { type: Schema.Types.ObjectId, ref: 'users', required: true },
        at: { type: Date, default: Date.now, required: true },
        reason: { type: String, required: true },
        before: { type: Schema.Types.Mixed, required: true },
      },
    ],
  },
  {
    collection: 'attendance',
  }
);

attendanceSchema.plugin(baseFieldsPlugin);
attendanceSchema.plugin(tenantScopePlugin);

attendanceSchema.index({ businessId: 1, staffId: 1, businessDate: 1 }, { unique: true });
attendanceSchema.index({ businessId: 1, branchId: 1, businessDate: 1 });

export const Attendance = model<IAttendance>('attendance', attendanceSchema);
