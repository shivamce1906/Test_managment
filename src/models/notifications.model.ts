import { Schema, model, Document, Types } from 'mongoose';

export interface INotification extends Document {
  businessId: Types.ObjectId;
  userId: Types.ObjectId;
  type: string;
  title: string;
  body: string;
  link?: string;
  readAt?: Date;
  createdAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'businesses', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'users', required: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    link: { type: String },
    readAt: { type: Date },
    createdAt: { type: Date, default: Date.now, required: true },
  },
  {
    collection: 'notifications',
    timestamps: false,
  }
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const Notification = model<INotification>('notifications', notificationSchema);
