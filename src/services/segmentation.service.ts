import { Types } from 'mongoose';
import { Customer, MarketingSegment, IMarketingSegment, ISegmentCriteria, Bill, CustomerPlan, Service } from '../models';
import { RequestContext, toObjectId } from './context';
import { AppError, ErrorCode } from '../utils';
import { getBusinessDate } from '../utils/dates';

export class SegmentationService {
  /**
   * Helper to compute YYYY-MM-DD offset from today in IST
   */
  private getDateNDaysAgo(days: number): string {
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return getBusinessDate(d);
  }

  /**
   * Builds the MongoDB query filter on the Customer collection for the given segment criteria.
   */
  async buildCustomerFilter(
    businessId: Types.ObjectId,
    criteria: ISegmentCriteria,
    options?: { enforceWaEligibility?: boolean }
  ): Promise<Record<string, any>> {
    const filter: Record<string, any> = {
      businessId,
      mergedInto: { $exists: false },
    };

    if (options?.enforceWaEligibility) {
      filter.doNotMessage = { $ne: true };
      filter.waOptIn = { $ne: false };
      filter.phone = { $exists: true, $ne: '' };
    }

    if (criteria.gender) {
      filter.gender = criteria.gender;
    }

    // 1. Customer Type (New vs Regular)
    if (criteria.customerType === 'new') {
      const thirtyDaysAgo = this.getDateNDaysAgo(30);
      filter['stats.visits'] = 1;
      filter['stats.firstVisit'] = { $gte: thirtyDaysAgo };
    } else if (criteria.customerType === 'regular') {
      const ninetyDaysAgo = this.getDateNDaysAgo(90);
      filter['stats.visits'] = { $gte: 3 };
      filter['stats.lastVisit'] = { $gte: ninetyDaysAgo };
    }

    // 2. Inactivity Windows (30, 60, 90 days)
    if (criteria.inactivityDays) {
      if (criteria.inactivityDays === 30) {
        const thirtyDaysAgo = this.getDateNDaysAgo(30);
        const sixtyDaysAgo = this.getDateNDaysAgo(60);
        filter['stats.lastVisit'] = { $lte: thirtyDaysAgo, $gt: sixtyDaysAgo };
      } else if (criteria.inactivityDays === 60) {
        const sixtyDaysAgo = this.getDateNDaysAgo(60);
        const ninetyDaysAgo = this.getDateNDaysAgo(90);
        filter['stats.lastVisit'] = { $lte: sixtyDaysAgo, $gt: ninetyDaysAgo };
      } else if (criteria.inactivityDays >= 90) {
        const cutoff = this.getDateNDaysAgo(criteria.inactivityDays);
        filter['stats.lastVisit'] = { $lte: cutoff };
      } else {
        const cutoff = this.getDateNDaysAgo(criteria.inactivityDays);
        filter['stats.lastVisit'] = { $lte: cutoff };
      }
    }

    // 3. High Spending Tier
    if (criteria.spendTier) {
      if (criteria.spendTier.type === 'min_spend') {
        filter['stats.spendPaise'] = { $gte: criteria.spendTier.value };
      } else if (criteria.spendTier.type === 'top_percentile') {
        // Calculate spend threshold for top percentile
        const percentile = Math.min(100, Math.max(1, criteria.spendTier.value));
        const totalWithSpend = await Customer.countDocuments({
          businessId,
          'stats.spendPaise': { $gt: 0 },
        });

        if (totalWithSpend > 0) {
          // Top X% means we skip the bottom (100 - X)%
          const skipCount = Math.floor(totalWithSpend * (1 - percentile / 100));
          const thresholdDoc = await Customer.find({ businessId, 'stats.spendPaise': { $gt: 0 } })
            .select('stats.spendPaise')
            .sort({ 'stats.spendPaise': 1 })
            .skip(skipCount)
            .limit(1)
            .lean();

          if (thresholdDoc && thresholdDoc.length > 0 && thresholdDoc[0].stats?.spendPaise) {
            filter['stats.spendPaise'] = { $gte: thresholdDoc[0].stats.spendPaise };
          }
        }
      }
    }

    // 4. Service-Based Customers (cross-collection query on Bills)
    if (
      (criteria.serviceIds && criteria.serviceIds.length > 0) ||
      (criteria.categoryIds && criteria.categoryIds.length > 0)
    ) {
      let targetServiceIds: Types.ObjectId[] = (criteria.serviceIds || []).map(toObjectId);
      if (criteria.categoryIds && criteria.categoryIds.length > 0) {
        const catServiceIds = await Service.find({
          businessId,
          categoryId: { $in: criteria.categoryIds.map(toObjectId) },
        }).distinct('_id');
        targetServiceIds = [...targetServiceIds, ...catServiceIds];
      }

      const billQuery: Record<string, any> = {
        businessId,
        status: { $in: ['paid', 'partly_paid'] },
        lines: {
          $elemMatch: {
            kind: 'service',
            refId: { $in: targetServiceIds },
          },
        },
      };

      if (criteria.serviceWithinDays) {
        const cutoffDate = this.getDateNDaysAgo(criteria.serviceWithinDays);
        billQuery.businessDate = { $gte: cutoffDate };
      }

      const customerIdsWithService = await Bill.distinct('customerId', billQuery);
      if (filter._id) {
        filter._id = { $in: customerIdsWithService.filter((id) => filter._id.$in?.includes(id)) };
      } else {
        filter._id = { $in: customerIdsWithService };
      }
    }

    // 5. Membership Customers (cross-collection query on CustomerPlans)
    if (criteria.membershipStatus) {
      const today = getBusinessDate();
      if (criteria.membershipStatus === 'active_any' || criteria.membershipStatus === 'plan_specific') {
        const planQuery: Record<string, any> = {
          businessId,
          status: 'active',
          validTill: { $gte: today },
        };

        if (criteria.membershipStatus === 'plan_specific' && criteria.planIds && criteria.planIds.length > 0) {
          planQuery.planId = { $in: criteria.planIds.map(toObjectId) };
        }

        const memberCustomerIds = await CustomerPlan.distinct('customerId', planQuery);
        if (filter._id) {
          filter._id = { $in: memberCustomerIds.filter((id) => filter._id.$in?.includes(id)) };
        } else {
          filter._id = { $in: memberCustomerIds };
        }
      } else if (criteria.membershipStatus === 'non_member') {
        const activeMemberIds = await CustomerPlan.distinct('customerId', {
          businessId,
          status: 'active',
          validTill: { $gte: today },
        });
        filter._id = { $nin: activeMemberIds };
      }
    }

    return filter;
  }

  /**
   * Returns audience calculation for a criteria: total matching, eligible for WA, and excluded count.
   */
  async previewSegment(
    ctx: RequestContext,
    criteria: ISegmentCriteria
  ): Promise<{
    totalMatched: number;
    eligibleForWa: number;
    excludedOptOut: number;
    sampleCustomers: Array<{ id: string; name: string; phone: string; visits: number; spendPaise: number }>;
  }> {
    if (!ctx.businessId) {
      throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
    }
    const businessId = toObjectId(ctx.businessId);

    const fullFilter = await this.buildCustomerFilter(businessId, criteria, { enforceWaEligibility: false });
    const waFilter = await this.buildCustomerFilter(businessId, criteria, { enforceWaEligibility: true });

    const [totalMatched, eligibleForWa, sample] = await Promise.all([
      Customer.countDocuments(fullFilter),
      Customer.countDocuments(waFilter),
      Customer.find(waFilter)
        .select('name phone stats.visits stats.spendPaise')
        .sort({ 'stats.lastVisit': -1 })
        .limit(10)
        .lean(),
    ]);

    return {
      totalMatched,
      eligibleForWa,
      excludedOptOut: Math.max(0, totalMatched - eligibleForWa),
      sampleCustomers: sample.map((c: any) => ({
        id: c._id.toString(),
        name: c.name,
        phone: c.phone,
        visits: c.stats?.visits || 0,
        spendPaise: c.stats?.spendPaise || 0,
      })),
    };
  }

  /**
   * Resolves customer IDs eligible for WhatsApp campaign send.
   */
  async resolveEligibleCustomerIds(
    businessId: Types.ObjectId,
    criteria: ISegmentCriteria
  ): Promise<Types.ObjectId[]> {
    const filter = await this.buildCustomerFilter(businessId, criteria, { enforceWaEligibility: true });
    return Customer.distinct('_id', filter);
  }

  /**
   * List of built-in system predefined segments.
   */
  getPredefinedSegments(): Array<{ key: string; name: string; description: string; criteria: ISegmentCriteria }> {
    return [
      {
        key: 'new_customers',
        name: 'New Customers',
        description: 'First visit within the last 30 days',
        criteria: { customerType: 'new' },
      },
      {
        key: 'regular_customers',
        name: 'Regular Customers',
        description: '3 or more visits with a visit in the last 90 days',
        criteria: { customerType: 'regular' },
      },
      {
        key: 'inactive_30',
        name: 'Inactive Customers (30 Days)',
        description: 'No visit between 30 and 60 days',
        criteria: { inactivityDays: 30 },
      },
      {
        key: 'inactive_60',
        name: 'Inactive Customers (60 Days)',
        description: 'No visit between 60 and 90 days',
        criteria: { inactivityDays: 60 },
      },
      {
        key: 'inactive_90',
        name: 'Inactive Customers (90+ Days)',
        description: 'No visit for over 90 days',
        criteria: { inactivityDays: 90 },
      },
      {
        key: 'high_spenders_top10',
        name: 'High Spenders (Top 10%)',
        description: 'Top 10% highest spending customers in the salon',
        criteria: { spendTier: { type: 'top_percentile', value: 10 } },
      },
      {
        key: 'active_members',
        name: 'Active Members',
        description: 'Customers with currently active memberships or packages',
        criteria: { membershipStatus: 'active_any' },
      },
    ];
  }

  // ----------------------------------------------------
  // Segment CRUD Operations
  // ----------------------------------------------------

  async createSegment(
    ctx: RequestContext,
    input: { name: string; description?: string; criteria: ISegmentCriteria }
  ): Promise<IMarketingSegment> {
    if (!ctx.businessId) {
      throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
    }
    const businessId = toObjectId(ctx.businessId);

    const preview = await this.previewSegment(ctx, input.criteria);

    const segment = await MarketingSegment.create({
      businessId,
      name: input.name,
      description: input.description,
      type: 'custom_rule',
      criteria: input.criteria,
      cachedCount: preview.eligibleForWa,
      lastCalculatedAt: new Date(),
      createdBy: toObjectId(ctx.userId),
    });

    return segment;
  }

  async getSegments(ctx: RequestContext): Promise<{ predefined: any[]; custom: IMarketingSegment[] }> {
    if (!ctx.businessId) {
      throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
    }
    const businessId = toObjectId(ctx.businessId);

    const custom = await MarketingSegment.find({ businessId }).sort({ createdAt: -1 });
    const predefined = this.getPredefinedSegments();

    return { predefined, custom };
  }

  async getSegmentById(ctx: RequestContext, segmentId: string): Promise<IMarketingSegment> {
    if (!ctx.businessId) {
      throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
    }
    const businessId = toObjectId(ctx.businessId);
    const segment = await MarketingSegment.findOne({ _id: toObjectId(segmentId), businessId });
    if (!segment) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Segment not found');
    }
    return segment;
  }

  async updateSegment(
    ctx: RequestContext,
    segmentId: string,
    input: { name?: string; description?: string; criteria?: ISegmentCriteria }
  ): Promise<IMarketingSegment> {
    if (!ctx.businessId) {
      throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
    }
    const businessId = toObjectId(ctx.businessId);

    const segment = await MarketingSegment.findOne({ _id: toObjectId(segmentId), businessId });
    if (!segment) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Segment not found');
    }

    if (input.name) segment.name = input.name;
    if (input.description !== undefined) segment.description = input.description;
    if (input.criteria) {
      segment.criteria = input.criteria;
      const preview = await this.previewSegment(ctx, input.criteria);
      segment.cachedCount = preview.eligibleForWa;
      segment.lastCalculatedAt = new Date();
    }

    await segment.save();
    return segment;
  }

  async deleteSegment(ctx: RequestContext, segmentId: string): Promise<{ success: boolean }> {
    if (!ctx.businessId) {
      throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
    }
    const businessId = toObjectId(ctx.businessId);
    const res = await MarketingSegment.deleteOne({ _id: toObjectId(segmentId), businessId });
    if (res.deletedCount === 0) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Segment not found');
    }
    return { success: true };
  }

  async getSegmentCustomers(
    ctx: RequestContext,
    segmentId: string,
    pagination: { page?: number; limit?: number }
  ): Promise<{ customers: any[]; total: number }> {
    if (!ctx.businessId) {
      throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
    }
    const segment = await this.getSegmentById(ctx, segmentId);
    const businessId = toObjectId(ctx.businessId);

    const filter = await this.buildCustomerFilter(businessId, segment.criteria, { enforceWaEligibility: true });
    const page = Math.max(1, pagination.page || 1);
    const limit = Math.min(100, Math.max(1, pagination.limit || 25));
    const skip = (page - 1) * limit;

    const [customers, total] = await Promise.all([
      Customer.find(filter)
        .select('name phone email stats.visits stats.spendPaise stats.lastVisit')
        .sort({ 'stats.lastVisit': -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Customer.countDocuments(filter),
    ]);

    return {
      customers: customers.map((c: any) => ({
        id: c._id.toString(),
        name: c.name,
        phone: c.phone,
        email: c.email,
        visits: c.stats?.visits || 0,
        spendPaise: c.stats?.spendPaise || 0,
        lastVisit: c.stats?.lastVisit,
      })),
      total,
    };
  }
}

export const segmentationService = new SegmentationService();

