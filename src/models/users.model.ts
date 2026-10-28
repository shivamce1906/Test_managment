import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IUser extends Document {
  businessId: Types.ObjectId;
  role: 'owner' | 'manager' | 'branch';
  name: string;
  email: string;
  phone?: string;
  passwordHash: string;
  branchIds: Types.ObjectId[];
  branchLoginFor?: Types.ObjectId;
  flags: {
    manageStaff?: boolean;
    approvePO?: boolean;
    viewPayroll?: boolean;
    editBranchPrices?: boolean;
    maxDiscountBps?: number;
    markAttendance?: boolean;
  };
  staffId?: Types.ObjectId;
  status: 'active' | 'inactive';
  sessionVersion: number;
  failedLogins: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  __v: number;
}

const userSchema = new Schema<IUser>(
  {
    role: { type: String, enum: ['owner', 'manager', 'branch'], required: true },
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String },
    passwordHash: { type: String, required: true },
    branchIds: [{ type: Schema.Types.ObjectId, ref: 'branches' }],
    branchLoginFor: { type: Schema.Types.ObjectId, ref: 'branches' },
    flags: {
      manageStaff: { type: Boolean, default: false },
      approvePO: { type: Boolean, default: false },
      viewPayroll: { type: Boolean, default: false },
      editBranchPrices: { type: Boolean, default: false },
      maxDiscountBps: { type: Number },
      markAttendance: { type: Boolean, default: false },
    },
    staffId: { type: Schema.Types.ObjectId, ref: 'staff' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', required: true },
    sessionVersion: { type: Number, default: 0, required: true },
    failedLogins: { type: Number, default: 0, required: true },
    lockedUntil: { type: Date },
    lastLoginAt: { type: Date },
  },
  {
    collection: 'users',
    toJSON: {
      transform(_doc, ret) {
        delete (ret as any).passwordHash;
        return ret;
      },
    },
    toObject: {
      transform(_doc, ret) {
        delete (ret as any).passwordHash;
        return ret;
      },
    },
  }
);

userSchema.plugin(baseFieldsPlugin);
userSchema.plugin(tenantScopePlugin);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ businessId: 1, role: 1 }, { unique: true, partialFilterExpression: { role: 'owner' } });
userSchema.index({ branchLoginFor: 1 }, { unique: true, sparse: true });

export const User = model<IUser>('users', userSchema);
