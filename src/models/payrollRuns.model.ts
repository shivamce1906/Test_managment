import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IPayrollLineAdjustment {
  field: string;
  deltaPaise: number;
  reason: string;
  by: Types.ObjectId;
  at: Date;
}

export interface IPayrollRunLine {
  staffId: Types.ObjectId;
  staffName: string;
  paidDays: number;
  salaryPaise: number;
  commissionPaise: number;
  overtimePaise: number;
  tipsPaise: number;
  incentivesPaise: number;
  advancePaise: number;
  pfPaise: number;
  esiPaise: number;
  ptPaise: number;
  otherDeductionPaise: number;
  netPaise: number;
  adjustments: IPayrollLineAdjustment[];
  paid?: {
    mode: string;
    date: string;
  };
}

export interface IPayrollRun extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  month: string;
  status: 'draft' | 'reviewed' | 'locked' | 'paid';
  lines: IPayrollRunLine[];
  totals: {
    netPaise: number;
    grossPaise?: number;
    deductionsPaise?: number;
  };
  /** When the lines were last (re)calculated; bills changed after this make the run stale. */
  generatedAt?: Date;
  lockedBy?: Types.ObjectId;
  lockedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const payrollRunSchema = new Schema<IPayrollRun>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    month: { type: String, required: true },
    status: {
      type: String,
      enum: ['draft', 'reviewed', 'locked', 'paid'],
      default: 'draft',
      required: true,
    },
    lines: [
      {
        staffId: { type: Schema.Types.ObjectId, ref: 'staff', required: true },
        staffName: { type: String, required: true },
        paidDays: { type: Number, required: true },
        salaryPaise: { type: Number, required: true },
        commissionPaise: { type: Number, default: 0, required: true },
        overtimePaise: { type: Number, default: 0, required: true },
        tipsPaise: { type: Number, default: 0, required: true },
        incentivesPaise: { type: Number, default: 0, required: true },
        advancePaise: { type: Number, default: 0, required: true },
        pfPaise: { type: Number, default: 0, required: true },
        esiPaise: { type: Number, default: 0, required: true },
        ptPaise: { type: Number, default: 0, required: true },
        otherDeductionPaise: { type: Number, default: 0, required: true },
        netPaise: { type: Number, required: true },
        adjustments: [
          {
            field: { type: String, required: true },
            deltaPaise: { type: Number, required: true },
            reason: { type: String, required: true },
            by: { type: Schema.Types.ObjectId, ref: 'users', required: true },
            at: { type: Date, default: Date.now, required: true },
          },
        ],
        paid: {
          mode: { type: String },
          date: { type: String },
        },
      },
    ],
    totals: {
      netPaise: { type: Number, required: true },
      grossPaise: { type: Number },
      deductionsPaise: { type: Number },
    },
    generatedAt: { type: Date },
    lockedBy: { type: Schema.Types.ObjectId, ref: 'users' },
    lockedAt: { type: Date },
  },
  {
    collection: 'payrollRuns',
  }
);

payrollRunSchema.plugin(baseFieldsPlugin);
payrollRunSchema.plugin(tenantScopePlugin);

payrollRunSchema.index({ businessId: 1, branchId: 1, month: 1 }, { unique: true });

export const PayrollRun = model<IPayrollRun>('payrollRuns', payrollRunSchema);
