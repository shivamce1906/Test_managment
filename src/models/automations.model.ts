import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export type AutomationKey =
  | 'booking_confirmation'
  | 'reminder_24h'
  | 'reminder_2h'
  | 'rebooking'
  | 'birthday'
  | 'anniversary'
  | 'winback'
  | 'feedback'
  | 'review_push'
  | 'membership_expiry'
  | 'package_last_session';

export interface IAutomation extends Document {
  businessId: Types.ObjectId;
  key: AutomationKey;
  enabled: boolean;
  templateId?: Types.ObjectId;
  settings: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const automationSchema = new Schema<IAutomation>(
  {
    key: {
      type: String,
      enum: [
        'booking_confirmation',
        'reminder_24h',
        'reminder_2h',
        'rebooking',
        'birthday',
        'anniversary',
        'winback',
        'feedback',
        'review_push',
        'membership_expiry',
        'package_last_session',
      ],
      required: true,
    },
    enabled: { type: Boolean, default: false, required: true },
    templateId: { type: Schema.Types.ObjectId, ref: 'waTemplates' },
    settings: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: 'automations',
  }
);

automationSchema.plugin(baseFieldsPlugin);
automationSchema.plugin(tenantScopePlugin);

automationSchema.index({ businessId: 1, key: 1 }, { unique: true });

export const Automation = model<IAutomation>('automations', automationSchema);
