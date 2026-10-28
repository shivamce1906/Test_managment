import { Schema, model, Document, Types } from 'mongoose';

export interface IImportJob extends Omit<Document, 'errors'> {
  businessId: Types.ObjectId;
  type: 'customers' | 'services' | 'products' | 'staff' | 'plans' | 'wallet';
  fileKey: string;
  status: 'validating' | 'ready' | 'importing' | 'done' | 'failed';
  errors: {
    row: number;
    message: string;
  }[];
  summary?: Record<string, any>;
  createdBy: Types.ObjectId;
  confirmedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const importJobSchema = new Schema<IImportJob>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'businesses', required: true },
    type: {
      type: String,
      enum: ['customers', 'services', 'products', 'staff', 'plans', 'wallet'],
      required: true,
    },
    fileKey: { type: String, required: true },
    status: {
      type: String,
      enum: ['validating', 'ready', 'importing', 'done', 'failed'],
      default: 'validating',
      required: true,
    },
    errors: [
      {
        row: { type: Number, required: true },
        message: { type: String, required: true },
      },
    ],
    summary: { type: Schema.Types.Mixed },
    createdBy: { type: Schema.Types.ObjectId, ref: 'platformAdmins', required: true },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'platformAdmins' },
  },
  {
    collection: 'importJobs',
    timestamps: true,
    suppressReservedKeysWarning: true,
  }
);

importJobSchema.index({ businessId: 1, createdAt: -1 });

export const ImportJob = model<IImportJob>('importJobs', importJobSchema);
