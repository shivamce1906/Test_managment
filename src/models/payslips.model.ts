import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IPayslip extends Document {
  businessId: Types.ObjectId;
  runId: Types.ObjectId;
  staffId: Types.ObjectId;
  month: string;
  pdfKey: string;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const payslipSchema = new Schema<IPayslip>(
  {
    runId: { type: Schema.Types.ObjectId, ref: 'payrollRuns', required: true },
    staffId: { type: Schema.Types.ObjectId, ref: 'staff', required: true },
    month: { type: String, required: true },
    pdfKey: { type: String, required: true },
    sentAt: { type: Date },
  },
  {
    collection: 'payslips',
  }
);

payslipSchema.plugin(baseFieldsPlugin);
payslipSchema.plugin(tenantScopePlugin);

payslipSchema.index({ businessId: 1, runId: 1, staffId: 1 }, { unique: true });

export const Payslip = model<IPayslip>('payslips', payslipSchema);
