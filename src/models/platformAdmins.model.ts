import { Schema, model, Document } from 'mongoose';

export interface IPlatformAdmin extends Document {
  name: string;
  email: string;
  passwordHash: string;
  status: 'active' | 'inactive';
  sessionVersion: number;
  failedLogins: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const platformAdminSchema = new Schema<IPlatformAdmin>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', required: true },
    sessionVersion: { type: Number, default: 0, required: true },
    failedLogins: { type: Number, default: 0, required: true },
    lockedUntil: { type: Date },
    lastLoginAt: { type: Date },
  },
  {
    collection: 'platformAdmins',
    timestamps: true,
  }
);

platformAdminSchema.index({ email: 1 }, { unique: true });

export const PlatformAdmin = model<IPlatformAdmin>('platformAdmins', platformAdminSchema);
