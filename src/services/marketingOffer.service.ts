import { Types } from 'mongoose';
import { MarketingOffer, IMarketingOffer, MarketingSegment, Bill, Customer } from '../models';
import { RequestContext, toObjectId } from './context';
import { AppError, ErrorCode } from '../utils';
import { segmentationService } from './segmentation.service';

export interface ValidateOfferInput {
  code: string;
  customerId: string;
  branchId?: string;
  grossPaise: number;
  items?: Array<{
    kind: 'service' | 'product';
    itemId: string;
    categoryId?: string;
    amountPaise: number;
  }>;
}

export interface ValidateOfferResult {
  valid: boolean;
  offerId: string;
  code: string;
  title: string;
  discountType: 'percentage' | 'flat';
  discountValue: number;
  discountPaise: number;
  reason?: string;
}

/** Percentage offers are in basis points: 2500 = 25 %, at most 10000 = 100 %. */
function assertPercentInRange(type: string | undefined, value: number | undefined) {
  if (type === 'percentage' && value !== undefined && value > 10000) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Validation failed', {
      fields: { discountValue: 'Percentage is in basis points (2500 = 25 %); at most 10000' },
    });
  }
}

export class MarketingOfferService {
  async createOffer(ctx: RequestContext, input: any): Promise<IMarketingOffer> {
    if (!ctx.businessId) {
      throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
    }
    const businessId = toObjectId(ctx.businessId);

    assertPercentInRange(input.discountType, input.discountValue);
    const code = input.code.trim().toUpperCase();
    const existing = await MarketingOffer.findOne({ businessId, code });
    if (existing) {
      throw new AppError(409, ErrorCode.ALREADY_EXISTS, `Offer code ${code} already exists`);
    }

    if (input.targetSegmentId) {
      const segmentExists = await MarketingSegment.exists({
        _id: toObjectId(input.targetSegmentId),
        businessId,
      });
      if (!segmentExists) {
        throw new AppError(404, ErrorCode.NOT_FOUND, 'Target segment not found');
      }
    }

    const offer = await MarketingOffer.create({
      businessId,
      code,
      title: input.title,
      description: input.description,
      offerType: input.offerType || 'festival',
      discountType: input.discountType,
      discountValue: input.discountValue,
      maxDiscountPaise: input.maxDiscountPaise,
      minBillAmountPaise: input.minBillAmountPaise || 0,
      applicableTo: input.applicableTo || { all: true, serviceIds: [], categoryIds: [], productIds: [] },
      targetSegmentId: input.targetSegmentId ? toObjectId(input.targetSegmentId) : undefined,
      validFrom: new Date(input.validFrom),
      validTill: new Date(input.validTill),
      usageLimitPerCustomer: input.usageLimitPerCustomer ?? 1,
      totalUsageLimit: input.totalUsageLimit,
      totalUsedCount: 0,
      branchScope: (input.branchScope || []).map(toObjectId),
      active: input.active !== undefined ? input.active : true,
      createdBy: toObjectId(ctx.userId),
    });

    return offer;
  }

  async getOffers(
    ctx: RequestContext,
    filter?: { activeOnly?: boolean; type?: string }
  ): Promise<IMarketingOffer[]> {
    if (!ctx.businessId) {
      throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
    }
    const businessId = toObjectId(ctx.businessId);

    const query: Record<string, any> = { businessId };
    if (filter?.activeOnly) {
      query.active = true;
      query.validTill = { $gte: new Date() };
    }
    if (filter?.type) {
      query.offerType = filter.type;
    }

    return MarketingOffer.find(query).populate('targetSegmentId', 'name').sort({ createdAt: -1 });
  }

  async getOfferById(ctx: RequestContext, offerId: string): Promise<IMarketingOffer> {
    if (!ctx.businessId) {
      throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
    }
    const businessId = toObjectId(ctx.businessId);
    const offer = await MarketingOffer.findOne({ _id: toObjectId(offerId), businessId }).populate('targetSegmentId', 'name');
    if (!offer) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Offer not found');
    }
    return offer;
  }

  async updateOffer(ctx: RequestContext, offerId: string, input: any): Promise<IMarketingOffer> {
    if (!ctx.businessId) {
      throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
    }
    const businessId = toObjectId(ctx.businessId);

    const offer = await MarketingOffer.findOne({ _id: toObjectId(offerId), businessId });
    if (!offer) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Offer not found');
    }
    assertPercentInRange(input.discountType ?? offer.discountType, input.discountValue ?? offer.discountValue);

    if (input.code) {
      const code = input.code.trim().toUpperCase();
      const duplicate = await MarketingOffer.findOne({ businessId, code, _id: { $ne: offer._id } });
      if (duplicate) {
        throw new AppError(409, ErrorCode.ALREADY_EXISTS, `Offer code ${code} is already in use`);
      }
      offer.code = code;
    }

    if (input.title) offer.title = input.title;
    if (input.description !== undefined) offer.description = input.description;
    if (input.discountType) offer.discountType = input.discountType;
    if (input.discountValue !== undefined) offer.discountValue = input.discountValue;
    if (input.maxDiscountPaise !== undefined) offer.maxDiscountPaise = input.maxDiscountPaise;
    if (input.minBillAmountPaise !== undefined) offer.minBillAmountPaise = input.minBillAmountPaise;
    if (input.applicableTo) offer.applicableTo = input.applicableTo;
    if (input.validFrom) offer.validFrom = new Date(input.validFrom);
    if (input.validTill) offer.validTill = new Date(input.validTill);
    if (input.usageLimitPerCustomer !== undefined) offer.usageLimitPerCustomer = input.usageLimitPerCustomer;
    if (input.totalUsageLimit !== undefined) offer.totalUsageLimit = input.totalUsageLimit;
    if (input.active !== undefined) offer.active = input.active;
    if (input.targetSegmentId !== undefined) {
      offer.targetSegmentId = input.targetSegmentId ? toObjectId(input.targetSegmentId) : undefined;
    }
    if (input.branchScope) {
      offer.branchScope = input.branchScope.map(toObjectId);
    }

    await offer.save();
    return offer;
  }

  async deleteOffer(ctx: RequestContext, offerId: string): Promise<{ success: boolean }> {
    if (!ctx.businessId) {
      throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
    }
    const businessId = toObjectId(ctx.businessId);
    const res = await MarketingOffer.deleteOne({ _id: toObjectId(offerId), businessId });
    if (res.deletedCount === 0) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Offer not found');
    }
    return { success: true };
  }

  /**
   * Validates an offer for checkout / POS billing and calculates applicable discount.
   */
  async validateOfferForCustomer(
    ctx: RequestContext,
    input: ValidateOfferInput
  ): Promise<ValidateOfferResult> {
    if (!ctx.businessId) {
      throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
    }
    const businessId = toObjectId(ctx.businessId);
    const code = input.code.trim().toUpperCase();

    const offer = await MarketingOffer.findOne({ businessId, code });
    if (!offer || !offer.active) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Invalid or inactive promotional code');
    }

    const now = new Date();
    if (now < offer.validFrom) {
      throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Offer is not active yet');
    }
    if (now > offer.validTill) {
      throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Offer has expired');
    }

    // Branch scope check
    if (input.branchId && offer.branchScope && offer.branchScope.length > 0) {
      const branchIdObj = toObjectId(input.branchId);
      const isAllowedBranch = offer.branchScope.some((b) => b.equals(branchIdObj));
      if (!isAllowedBranch) {
        throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Offer is not valid at this branch');
      }
    }

    // Minimum bill value check
    if (offer.minBillAmountPaise && input.grossPaise < offer.minBillAmountPaise) {
      throw new AppError(
        422,
        ErrorCode.VALIDATION_ERROR,
        `Bill amount must be at least ₹${(offer.minBillAmountPaise / 100).toFixed(2)} to apply this offer`
      );
    }

    // Overall total usage limit
    if (offer.totalUsageLimit && offer.totalUsedCount >= offer.totalUsageLimit) {
      throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Offer total usage limit has been reached');
    }

    const customerId = toObjectId(input.customerId);

    // Customer usage limit
    if (offer.usageLimitPerCustomer) {
      const usedByCustomer = await Bill.countDocuments({
        businessId,
        customerId,
        'marketingOffer.offerId': offer._id,
        status: { $in: ['paid', 'partly_paid', 'awaiting_approval'] },
      });

      if (usedByCustomer >= offer.usageLimitPerCustomer) {
        throw new AppError(
          422,
          ErrorCode.VALIDATION_ERROR,
          `You have already reached the maximum redemption limit (${offer.usageLimitPerCustomer}) for this offer`
        );
      }
    }

    // Segment gating: check if customer satisfies the target segment
    if (offer.targetSegmentId) {
      const segment = await MarketingSegment.findOne({ _id: offer.targetSegmentId, businessId });
      if (segment) {
        const filter = await segmentationService.buildCustomerFilter(businessId, segment.criteria, {
          enforceWaEligibility: false,
        });
        filter._id = customerId;
        const belongsToSegment = await Customer.exists(filter);
        if (!belongsToSegment) {
          throw new AppError(
            422,
            ErrorCode.VALIDATION_ERROR,
            'This offer is exclusive to select customer segments'
          );
        }
      }
    }

    // Calculate discount
    let discountPaise = 0;
    if (offer.discountType === 'percentage') {
      discountPaise = Math.round((input.grossPaise * offer.discountValue) / 10000);
      if (offer.maxDiscountPaise && discountPaise > offer.maxDiscountPaise) {
        discountPaise = offer.maxDiscountPaise;
      }
    } else if (offer.discountType === 'flat') {
      discountPaise = Math.min(input.grossPaise, offer.discountValue);
    }

    return {
      valid: true,
      offerId: offer._id.toString(),
      code: offer.code,
      title: offer.title,
      discountType: offer.discountType,
      discountValue: offer.discountValue,
      discountPaise,
    };
  }

  /**
   * Increments the total redemption count when a bill is successfully saved.
   */
  async recordOfferRedemption(businessId: Types.ObjectId, offerId: Types.ObjectId): Promise<void> {
    await MarketingOffer.findOneAndUpdate({ _id: offerId, businessId }, { $inc: { totalUsedCount: 1 } });
  }
}

export const marketingOfferService = new MarketingOfferService();
