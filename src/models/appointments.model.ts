import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IAppointmentLine {
  _id: Types.ObjectId;
  serviceId: Types.ObjectId;
  serviceName: string;
  staffId: Types.ObjectId;
  start: Date;
  end: Date;
}

export interface IAppointment extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  customerId: Types.ObjectId;
  businessDate: string;
  lines: IAppointmentLine[];
  start: Date;
  end: Date;
  status: 'booked' | 'confirmed' | 'arrived' | 'in_service' | 'completed' | 'billed' | 'cancelled' | 'no_show';
  statusLog: {
    status: string;
    at: Date;
    by: Types.ObjectId;
    reason?: string;
  }[];
  source: 'walk_in' | 'phone' | 'whatsapp';
  notes?: string;
  billId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  __v: number;
}

const appointmentSchema = new Schema<IAppointment>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'customers', required: true },
    businessDate: { type: String, required: true },
    lines: [
      {
        serviceId: { type: Schema.Types.ObjectId, ref: 'services', required: true },
        serviceName: { type: String, required: true },
        staffId: { type: Schema.Types.ObjectId, ref: 'staff', required: true },
        start: { type: Date, required: true },
        end: { type: Date, required: true },
      },
    ],
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    status: {
      type: String,
      enum: ['booked', 'confirmed', 'arrived', 'in_service', 'completed', 'billed', 'cancelled', 'no_show'],
      default: 'booked',
      required: true,
    },
    statusLog: [
      {
        status: { type: String, required: true },
        at: { type: Date, default: Date.now, required: true },
        by: { type: Schema.Types.ObjectId, ref: 'users', required: true },
        reason: { type: String },
      },
    ],
    source: { type: String, enum: ['walk_in', 'phone', 'whatsapp'], default: 'phone', required: true },
    notes: { type: String },
    billId: { type: Schema.Types.ObjectId, ref: 'bills' },
  },
  {
    collection: 'appointments',
  }
);

appointmentSchema.plugin(baseFieldsPlugin);
appointmentSchema.plugin(tenantScopePlugin);

appointmentSchema.index({ businessId: 1, branchId: 1, businessDate: 1 });
appointmentSchema.index({ businessId: 1, 'lines.staffId': 1, 'lines.start': 1 });
appointmentSchema.index({ businessId: 1, customerId: 1, start: -1 });

export const Appointment = model<IAppointment>('appointments', appointmentSchema);
