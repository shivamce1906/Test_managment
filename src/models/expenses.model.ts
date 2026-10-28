import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IExpense extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  businessDate: string;
  category: 'rent' | 'electricity' | 'salary_advance' | 'tea_snacks' | 'repairs' | 'marketing' | 'other';
  amountPaise: number;
  mode: 'cash' | 'upi' | 'card' | 'bank';
  paidFrom: 'till' | 'petty_cash' | 'bank';
  note?: string;
  receiptKey?: string;
  recurringId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  __v: number;
}

const expenseSchema = new Schema<IExpense>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    businessDate: { type: String, required: true },
    category: {
      type: String,
      enum: ['rent', 'electricity', 'salary_advance', 'tea_snacks', 'repairs', 'marketing', 'other'],
      required: true,
    },
    amountPaise: { type: Number, required: true },
    mode: { type: String, enum: ['cash', 'upi', 'card', 'bank'], required: true },
    paidFrom: { type: String, enum: ['till', 'petty_cash', 'bank'], required: true },
    note: { type: String },
    receiptKey: { type: String },
    recurringId: { type: Schema.Types.ObjectId, ref: 'recurringExpenses' },
  },
  {
    collection: 'expenses',
  }
);

expenseSchema.plugin(baseFieldsPlugin);
expenseSchema.plugin(tenantScopePlugin);

expenseSchema.index({ businessId: 1, branchId: 1, businessDate: -1 });

export const Expense = model<IExpense>('expenses', expenseSchema);
