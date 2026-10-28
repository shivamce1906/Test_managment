import { Schema } from 'mongoose';

export function baseFieldsPlugin(schema: Schema) {
  schema.add({
    createdBy: {
      type: Schema.Types.ObjectId,
      refPath: 'createdByModel',
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      refPath: 'updatedByModel',
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  });

  schema.set('timestamps', true);
  schema.set('optimisticConcurrency', true);
}
