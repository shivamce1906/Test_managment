import { Schema } from 'mongoose';
import { AppError } from '../../utils';

export function tenantScopePlugin(schema: Schema) {
  // Ensure businessId is defined in schema
  if (!schema.path('businessId')) {
    schema.add({
      businessId: {
        type: Schema.Types.ObjectId,
        ref: 'businesses',
        required: true,
        index: true,
      },
    });
  }

  const queryOps = [
    'find',
    'findOne',
    'findOneAndUpdate',
    'findOneAndDelete',
    'findOneAndReplace',
    'updateOne',
    'updateMany',
    'deleteOne',
    'deleteMany',
    'countDocuments',
  ];

  queryOps.forEach((op) => {
    schema.pre(op as any, function (this: any) {
      // Populate runs a plain `find({ _id: { $in } })` on the referenced model. Those ids come from
      // documents this (tenant-checked) query returns, so the child queries may skip the check.
      const populate = this._mongooseOptions?.populate;
      if (populate) {
        for (const spec of Object.values<any>(populate)) {
          spec.options = { ...(spec.options || {}), skipTenantScope: true };
        }
      }

      if (this.options && this.options.skipTenantScope === true) {
        return;
      }
      const filter = this.getFilter();
      if (!filter || filter.businessId === undefined) {
        throw new AppError(500, 'TENANT_SCOPE_MISSING', `Tenant query for ${op} missing businessId filter`);
      }
    });
  });

  schema.pre('aggregate', function (this: any) {
    if (this.options && this.options.skipTenantScope === true) {
      return;
    }
    const pipeline = this.pipeline();
    if (!pipeline.length || !pipeline[0].$match || pipeline[0].$match.businessId === undefined) {
      throw new AppError(500, 'TENANT_SCOPE_MISSING', 'Tenant aggregation must start with $match containing businessId');
    }
  });
}
