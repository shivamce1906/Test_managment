import { Model, Types } from 'mongoose';
import { AppError } from '../utils';
import { toObjectId } from './context';

/**
 * Throws 404 unless every id refers to a document of this business. Guards request bodies that
 * point at other records (branchIds, productIds, staffIds, …) against ids from another tenant.
 */
export async function assertRefsInBusiness(
  model: Model<any>,
  businessId: Types.ObjectId | string,
  ids: (string | Types.ObjectId)[] | undefined,
  label: string
): Promise<void> {
  const unique = [...new Set((ids || []).map((id) => id.toString()))];
  if (unique.length === 0) return;
  const found = await model.countDocuments({ businessId: toObjectId(businessId), _id: { $in: unique.map(toObjectId) } });
  if (found !== unique.length) {
    throw new AppError(404, 'NOT_FOUND', `One or more ${label} were not found in this business`);
  }
}
