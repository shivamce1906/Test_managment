import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface ICategory extends Document {
  businessId: Types.ObjectId;
  name: string;
  parentId?: Types.ObjectId;
  gender: 'men' | 'women' | 'unisex';
  order: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  __v: number;
}

const categorySchema = new Schema<ICategory>(
  {
    name: { type: String, required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'categories' },
    gender: { type: String, enum: ['men', 'women', 'unisex'], required: true },
    order: { type: Number, default: 0, required: true },
    active: { type: Boolean, default: true, required: true },
  },
  {
    collection: 'categories',
  }
);

categorySchema.plugin(baseFieldsPlugin);
categorySchema.plugin(tenantScopePlugin);

categorySchema.index({ businessId: 1, parentId: 1, order: 1 });

export const Category = model<ICategory>('categories', categorySchema);
