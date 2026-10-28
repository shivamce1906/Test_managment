import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IRecurringExpense extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  category: string;
  amountPaise: number;
  dayOfMonth: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const recurringExpenseSchema = new Schema<IRecurringExpense>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    category: { type: String, required: true },
    amountPaise: { type: Number, required: true },
    dayOfMonth: { type: Number, min: 1, max: 31, required: true },
    active: { type: Boolean, default: true, required: true },
  },
  {
    collection: 'recurringExpenses',
  }
);

recurringExpenseSchema.plugin(baseFieldsPlugin);
recurringExpenseSchema.plugin(tenantScopePlugin);

recurringExpenseSchema.index({ businessId: 1, branchId: 1, active: 1 });

export const RecurringExpense = model<IRecurringExpense>('recurringExpenses', recurringExpenseSchema);
