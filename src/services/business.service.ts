import { Types } from 'mongoose';
import {
  Business,
  Branch,
  BranchRequest,
  User,
  EmailRegistry,
  withTransaction,
  IBusiness,
  IBranch,
  IUser,
} from '../models';
import { AppError, hashPassword, normalizePhone } from '../utils';
import { createBranchSchema } from '../validations';
import { RequestContext, toObjectId } from './context';
import { auditService } from './audit.service';
import { authService } from './auth.service';
import { assertRefsInBusiness } from './tenant-refs';

/** A user as plain JSON with the password hash removed, safe to return from the API. */
export type SafeUser = Record<string, any>;

function toSafeUser(user: IUser): SafeUser {
  const { passwordHash, ...rest } = user.toObject();
  return rest;
}

const skipScope = { skipTenantScope: true };

const isPlainObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Types.ObjectId) && !(v instanceof Date);

/** Deep-merges partial settings (gst, discountLimits, payroll.pf, …) so unsent nested fields are kept. */
function mergeSettings(current: Record<string, any>, updates: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(current[key]) ? mergeSettings(current[key], value) : value;
  }
  return out;
}

function applyBusinessUpdates(business: IBusiness, updates: Record<string, any>): void {
  const merged = mergeSettings(business.toObject(), updates);
  for (const key of Object.keys(updates)) {
    business.set(key, merged[key]);
  }
  if (business.gst?.enabled && !business.gst.gstin?.trim()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'GSTIN is required when GST is enabled', {
      fields: { 'gst.gstin': 'GSTIN is required when GST is enabled' },
    });
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class BusinessService {
  /**
   * Super Admin creates a new business with owner and head branch in one transaction.
   */
  async createBusiness(data: {
    business: any;
    owner: { name: string; email: string; phone?: string; password: string };
    headBranch: {
      name: string;
      code: string;
      invoicePrefix: string;
      address: any;
      phone: string;
      loginEmail: string;
      loginPassword: string;
    };
  }): Promise<{ business: IBusiness; owner: SafeUser; branch: IBranch; branchLogin: SafeUser }> {
    const ownerEmail = data.owner.email.trim().toLowerCase();
    const branchEmail = data.headBranch.loginEmail.trim().toLowerCase();

    if (ownerEmail === branchEmail) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Owner email and branch login email must be different');
    }

    // Check duplicate emails
    const existing = await EmailRegistry.find({ _id: { $in: [ownerEmail, branchEmail] } });
    if (existing.length > 0) {
      throw new AppError(409, 'DUPLICATE_EMAIL', `Email ${existing[0]._id} is already in use`);
    }

    return withTransaction(async (session) => {
      // 1. Create Business
      const business = new Business({
        name: data.business.name,
        logoUrl: data.business.logoUrl,
        address: data.business.address,
        gst: data.business.gst,
        fyStartMonth: data.business.fyStartMonth || 4,
        discountLimits: data.business.discountLimits,
        dayEndReportTime: data.business.dayEndReportTime || '23:00',
        loyalty: data.business.loyalty || { enabled: false },
        payroll: data.business.payroll || { pf: { enabled: false }, esi: { enabled: false }, pt: { enabled: false } },
        automationGuards: data.business.automationGuards || { quietStart: '21:00', quietEnd: '09:00', maxMarketingPerDay: 1 },
        ownerWhatsappPhone: data.business.ownerWhatsappPhone,
        status: 'active',
      });
      await business.save({ session });
      const businessId = business._id;

      // 2. Create Head Branch
      const branch = new Branch({
        businessId,
        name: data.headBranch.name,
        code: data.headBranch.code.toUpperCase(),
        invoicePrefix: data.headBranch.invoicePrefix.toUpperCase(),
        address: data.headBranch.address,
        phone: data.headBranch.phone,
        stations: 4,
        pettyCashFloatPaise: 0,
        status: 'active',
      });
      await branch.save({ session });
      const branchId = branch._id;

      // Link head branch to business
      business.headBranchId = branchId;
      await business.save({ session });

      // 3. Create Owner User
      const ownerHash = await hashPassword(data.owner.password);
      const owner = new User({
        businessId,
        role: 'owner',
        name: data.owner.name,
        email: ownerEmail,
        phone: data.owner.phone,
        passwordHash: ownerHash,
        branchIds: [],
        flags: {},
        status: 'active',
        sessionVersion: 0,
        failedLogins: 0,
      });
      await owner.save({ session });

      // 4. Create Branch Login User
      const branchHash = await hashPassword(data.headBranch.loginPassword);
      const branchLogin = new User({
        businessId,
        role: 'branch',
        name: data.headBranch.name,
        email: branchEmail,
        phone: data.headBranch.phone,
        passwordHash: branchHash,
        branchIds: [branchId],
        branchLoginFor: branchId,
        flags: { markAttendance: false },
        status: 'active',
        sessionVersion: 0,
        failedLogins: 0,
      });
      await branchLogin.save({ session });

      // 5. Reserve Emails in EmailRegistry
      await EmailRegistry.insertMany(
        [
          { _id: ownerEmail, kind: 'tenant', businessId, userId: owner._id },
          { _id: branchEmail, kind: 'tenant', businessId, userId: branchLogin._id },
        ],
        { session }
      );

      return { business, owner: toSafeUser(owner), branch, branchLogin: toSafeUser(branchLogin) };
    });
  }

  /**
   * Super Admin updates business details or suspends business.
   */
  async updateBusinessByAdmin(ctx: RequestContext, businessId: string, updates: any): Promise<IBusiness> {
    const business = await Business.findById(businessId);
    if (!business) {
      throw new AppError(404, 'NOT_FOUND', 'Business not found');
    }

    const previousStatus = business.status;
    applyBusinessUpdates(business, updates);
    await business.save();

    if (updates.status === 'suspended' && previousStatus !== 'suspended') {
      // Revoke sessions of all users in the business
      const users = await User.find({ businessId: business._id }, null, { skipTenantScope: true });
      for (const u of users) {
        await authService.revokeAllSessions(u._id.toString());
      }
    }

    await auditService.logAction({
      ctx,
      action: 'business.update',
      entity: 'business',
      entityId: business._id,
      businessId: business._id.toString(),
      after: updates,
    });

    return business;
  }

  /**
   * Super Admin creates a new branch and its login credentials.
   */
  async createBranchByAdmin(
    ctx: RequestContext,
    businessIdStr: string,
    data: {
      name: string;
      code: string;
      invoicePrefix: string;
      address: any;
      phone: string;
      loginEmail: string;
      loginPassword: string;
      stations?: number;
      pettyCashFloatPaise?: number;
    }
  ): Promise<{ branch: IBranch; branchLogin: SafeUser }> {
    const businessId = toObjectId(businessIdStr);
    const branchEmail = data.loginEmail.trim().toLowerCase();

    if (!(await Business.exists({ _id: businessId }))) {
      throw new AppError(404, 'NOT_FOUND', 'Business not found');
    }

    // Check duplicate email
    const existing = await EmailRegistry.findById(branchEmail);
    if (existing) {
      throw new AppError(409, 'DUPLICATE_EMAIL', `Email ${branchEmail} is already in use`);
    }

    // Check duplicate code or prefix
    const dup = await Branch.findOne(
      {
        businessId,
        $or: [{ code: data.code.toUpperCase() }, { invoicePrefix: data.invoicePrefix.toUpperCase() }],
      },
      null,
      { skipTenantScope: true }
    );
    if (dup) {
      throw new AppError(409, 'VERSION_CONFLICT', 'Branch code or invoice prefix is already taken in this business');
    }

    return withTransaction(async (session) => {
      const branch = new Branch({
        businessId,
        name: data.name,
        code: data.code.toUpperCase(),
        invoicePrefix: data.invoicePrefix.toUpperCase(),
        address: data.address,
        phone: data.phone,
        stations: data.stations || 4,
        pettyCashFloatPaise: data.pettyCashFloatPaise || 0,
        status: 'active',
      });
      await branch.save({ session });

      const passwordHash = await hashPassword(data.loginPassword);
      const branchLogin = new User({
        businessId,
        role: 'branch',
        name: data.name,
        email: branchEmail,
        phone: data.phone,
        passwordHash,
        branchIds: [branch._id],
        branchLoginFor: branch._id,
        flags: { markAttendance: false },
        status: 'active',
        sessionVersion: 0,
        failedLogins: 0,
      });
      await branchLogin.save({ session });

      await new EmailRegistry({
        _id: branchEmail,
        kind: 'tenant',
        businessId,
        userId: branchLogin._id,
      }).save({ session });

      await auditService.logAction({
        ctx,
        action: 'branch.create',
        entity: 'branch',
        entityId: branch._id,
        after: { name: branch.name, code: branch.code },
        businessId: businessId.toString(),
        branchId: branch._id,
        session,
      });

      return { branch, branchLogin: toSafeUser(branchLogin) };
    });
  }

  /**
   * Super Admin deactivates a branch (read-only, branch user deactivated, head branch cannot be deactivated).
   */
  async deactivateBranchByAdmin(ctx: RequestContext, branchIdStr: string, reason: string): Promise<IBranch> {
    const branchId = toObjectId(branchIdStr);
    const branch = await Branch.findById(branchId, null, { skipTenantScope: true });
    if (!branch) {
      throw new AppError(404, 'NOT_FOUND', 'Branch not found');
    }

    const business = await Business.findById(branch.businessId);
    if (business && business.headBranchId?.equals(branchId)) {
      throw new AppError(403, 'FORBIDDEN', 'Head branch cannot be deactivated');
    }

    branch.status = 'deactivated';
    await branch.save();

    // Deactivate branch login user and revoke session
    const branchUser = await User.findOne({ branchLoginFor: branchId }, null, { skipTenantScope: true });
    if (branchUser) {
      branchUser.status = 'inactive';
      await branchUser.save();
      await authService.revokeAllSessions(branchUser._id.toString());
    }

    await auditService.logAction({
      ctx,
      action: 'branch.deactivate',
      entity: 'branch',
      entityId: branch._id,
      businessId: branch.businessId.toString(),
      branchId: branch._id,
      reason,
    });

    return branch;
  }

  /**
   * Owner raises a branch request (add or delete).
   */
  async createBranchRequest(
    ctx: RequestContext,
    data: { type: 'add' | 'delete'; branchId?: string; payload?: any; reason: string }
  ): Promise<any> {
    if (ctx.role !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only owner can raise branch requests');
    }

    const businessId = toObjectId(ctx.businessId!);

    if (data.type === 'delete') {
      if (!data.branchId) {
        throw new AppError(400, 'VALIDATION_ERROR', 'branchId required for delete request');
      }
      const branch = await Branch.findOne({ _id: toObjectId(data.branchId), businessId });
      if (!branch) {
        throw new AppError(404, 'NOT_FOUND', 'Branch not found');
      }
      const business = await Business.findById(businessId);
      if (business?.headBranchId?.equals(branch._id)) {
        throw new AppError(403, 'FORBIDDEN', 'Head branch cannot be requested for deletion');
      }
      branch.status = 'deactivation_requested';
      await branch.save();
    }

    const req = new BranchRequest({
      businessId,
      type: data.type,
      branchId: data.branchId ? toObjectId(data.branchId) : undefined,
      payload: data.payload,
      reason: data.reason,
      status: 'pending',
    });
    await req.save();

    await auditService.logAction({
      ctx,
      action: `branch_request.${data.type}`,
      entity: 'branchRequest',
      entityId: req._id,
      reason: data.reason,
    });

    return req;
  }

  /**
   * Super Admin dashboard counts across all businesses.
   */
  async getPlatformStats(): Promise<{
    businesses: { total: number; active: number; suspended: number };
    branches: { total: number; active: number };
    users: { owners: number; managers: number; branchLogins: number };
    pendingBranchRequests: number;
  }> {
    const [active, suspended, branchesTotal, branchesActive, owners, managers, branchLogins, pendingBranchRequests] =
      await Promise.all([
        Business.countDocuments({ status: 'active' }),
        Business.countDocuments({ status: 'suspended' }),
        Branch.countDocuments({}, skipScope),
        Branch.countDocuments({ status: 'active' }, skipScope),
        User.countDocuments({ role: 'owner' }, skipScope),
        User.countDocuments({ role: 'manager' }, skipScope),
        User.countDocuments({ role: 'branch' }, skipScope),
        BranchRequest.countDocuments({ status: 'pending' }, skipScope),
      ]);

    return {
      businesses: { total: active + suspended, active, suspended },
      branches: { total: branchesTotal, active: branchesActive },
      users: { owners, managers, branchLogins },
      pendingBranchRequests,
    };
  }

  /**
   * Super Admin lists businesses, newest first, with owner and active branch count.
   */
  async listBusinesses(filters: {
    page: number;
    limit: number;
    q?: string;
    status?: 'active' | 'suspended';
  }): Promise<{ businesses: any[]; total: number }> {
    const query: any = {};
    if (filters.status) query.status = filters.status;
    if (filters.q) query.name = { $regex: escapeRegex(filters.q), $options: 'i' };

    const [rows, total] = await Promise.all([
      Business.find(query)
        .sort({ createdAt: -1 })
        .skip((filters.page - 1) * filters.limit)
        .limit(filters.limit)
        .lean(),
      Business.countDocuments(query),
    ]);

    const ids = rows.map((b) => b._id);
    const [owners, branchCounts] = await Promise.all([
      User.find({ businessId: { $in: ids }, role: 'owner' }).select('businessId name email phone status').lean(),
      Branch.aggregate([
        { $match: { businessId: { $in: ids }, status: { $ne: 'deactivated' } } },
        { $group: { _id: '$businessId', n: { $sum: 1 } } },
      ]),
    ]);

    const ownerByBusiness = new Map(owners.map((o) => [o.businessId.toString(), o]));
    const countByBusiness = new Map(branchCounts.map((c) => [c._id.toString(), c.n]));

    const businesses = rows.map((b) => {
      const owner = ownerByBusiness.get(b._id.toString());
      return {
        ...b,
        owner: owner ? { _id: owner._id, name: owner.name, email: owner.email, phone: owner.phone, status: owner.status } : null,
        branchCount: countByBusiness.get(b._id.toString()) || 0,
      };
    });

    return { businesses, total };
  }

  /**
   * Super Admin views one business with its owner, branches and user counts.
   */
  async getBusinessDetail(businessIdStr: string): Promise<{
    business: any;
    owner: any;
    branches: any[];
    counts: { managers: number; branchLogins: number };
  }> {
    const businessId = toObjectId(businessIdStr);
    const business = await Business.findById(businessId).lean();
    if (!business) {
      throw new AppError(404, 'NOT_FOUND', 'Business not found');
    }

    const [owner, branches, managers, branchLogins] = await Promise.all([
      User.findOne({ businessId, role: 'owner' }).select('-passwordHash').lean(),
      Branch.find({ businessId }).sort({ createdAt: 1 }).lean(),
      User.countDocuments({ businessId, role: 'manager' }),
      User.countDocuments({ businessId, role: 'branch' }),
    ]);

    return { business, owner, branches, counts: { managers, branchLogins } };
  }

  /**
   * Super Admin lists the owner, managers and branch logins of a business.
   */
  async listBusinessUsers(businessIdStr: string, role?: 'owner' | 'manager' | 'branch'): Promise<any[]> {
    const businessId = toObjectId(businessIdStr);
    if (!(await Business.exists({ _id: businessId }))) {
      throw new AppError(404, 'NOT_FOUND', 'Business not found');
    }

    const query: any = { businessId };
    if (role) query.role = role;
    return User.find(query).select('-passwordHash').sort({ role: 1, createdAt: 1 }).lean();
  }

  /**
   * Super Admin activates or deactivates any salon user. Deactivating revokes their sessions.
   */
  async setUserStatusByAdmin(ctx: RequestContext, userIdStr: string, status: 'active' | 'inactive'): Promise<SafeUser> {
    const user = await User.findById(toObjectId(userIdStr), null, skipScope);
    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    if (status === 'active' && user.role === 'branch') {
      const branch = await Branch.findById(user.branchLoginFor, null, skipScope);
      if (!branch || branch.status === 'deactivated') {
        throw new AppError(409, 'BRANCH_INACTIVE', 'Branch is deactivated; its login cannot be reactivated');
      }
    }

    const before = user.status;
    user.status = status;
    await user.save();

    if (status === 'inactive' && before !== 'inactive') {
      await authService.revokeAllSessions(user._id.toString());
    }

    await auditService.logAction({
      ctx,
      action: 'user.status_update',
      entity: 'user',
      entityId: user._id,
      businessId: user.businessId.toString(),
      before: { status: before },
      after: { status },
    });

    return toSafeUser(user);
  }

  /**
   * Super Admin lists branch requests by status
   */
  async getBranchRequests(status: string = 'pending'): Promise<any[]> {
    return BranchRequest.find({ status }, null, { skipTenantScope: true }).populate('businessId', 'name');
  }

  /**
   * Super Admin approves or rejects a branch request.
   */
  async handleBranchRequest(
    ctx: RequestContext,
    requestId: string,
    action: 'approve' | 'reject',
    details?: any
  ): Promise<any> {
    const req = await BranchRequest.findById(requestId, null, { skipTenantScope: true });
    if (!req) {
      throw new AppError(404, 'NOT_FOUND', 'Branch request not found');
    }
    if (req.status !== 'pending') {
      throw new AppError(409, 'VERSION_CONFLICT', 'Request has already been decided');
    }

    if (action === 'reject') {
      req.status = 'rejected';
      req.handledBy = toObjectId(ctx.userId);
      req.handledAt = new Date();
      req.rejectReason = details?.reason || 'Rejected by superadmin';
      await req.save();

      // If was delete request, revert branch status to active
      if (req.type === 'delete' && req.branchId) {
        await Branch.updateOne(
          { _id: req.branchId },
          { $set: { status: 'active' } },
          { skipTenantScope: true } as any
        );
      }

      return req;
    }

    // Approve
    if (req.type === 'delete') {
      await this.deactivateBranchByAdmin(ctx, req.branchId!.toString(), req.reason);
      req.status = 'approved';
      req.handledBy = toObjectId(ctx.userId);
      req.handledAt = new Date();
      await req.save();
      return req;
    } else {
      // Add branch: the owner's request has name + address, the Super Admin supplies the rest
      const parsed = createBranchSchema.safeParse({
        ...details,
        name: req.payload!.name,
        address: req.payload!.address,
        phone: details?.phone || '0000000000',
      });
      if (!parsed.success) {
        const fields = Object.fromEntries(parsed.error.issues.map((i) => [`note.${i.path.join('.')}`, i.message]));
        throw new AppError(400, 'VALIDATION_ERROR', 'Branch details are required to approve an add request', { fields });
      }
      const result = await this.createBranchByAdmin(ctx, req.businessId.toString(), parsed.data);

      req.status = 'approved';
      req.branchId = result.branch._id;
      req.handledBy = toObjectId(ctx.userId);
      req.handledAt = new Date();
      await req.save();
      return { request: req, branch: result.branch, branchLogin: result.branchLogin };
    }
  }

  /**
   * Owner updates business settings.
   */
  async updateBusinessSettings(ctx: RequestContext, updates: any): Promise<IBusiness> {
    if (ctx.role !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only owner can update business settings');
    }
    const business = await Business.findById(ctx.businessId);
    if (!business) {
      throw new AppError(404, 'NOT_FOUND', 'Business not found');
    }

    const before = business.toObject();
    applyBusinessUpdates(business, updates);
    await business.save();

    await auditService.logAction({
      ctx,
      action: 'business.settings_update',
      entity: 'business',
      entityId: business._id,
      before,
      after: updates,
    });

    return business;
  }

  /**
   * Gets business settings with field restrictions based on user role.
   */
  async getBusinessSettings(ctx: RequestContext): Promise<any> {
    const business = await Business.findById(ctx.businessId);
    if (!business) {
      throw new AppError(404, 'NOT_FOUND', 'Business not found');
    }

    if (ctx.role === 'owner') {
      return business;
    }

    // Manager and Branch see limited settings
    return {
      name: business.name,
      logoUrl: business.logoUrl,
      address: business.address,
      gst: {
        enabled: business.gst.enabled,
        rateBps: business.gst.rateBps,
        pricesInclusive: business.gst.pricesInclusive,
      },
      discountLimits: business.discountLimits,
    };
  }

  /**
   * Gets branches accessible to current user.
   */
  async getBranches(ctx: RequestContext): Promise<IBranch[]> {
    const businessId = toObjectId(ctx.businessId!);
    const query: any = { businessId };

    if (ctx.role === 'manager' || ctx.role === 'branch') {
      const allowed = ctx.branchIds.map(toObjectId);
      query._id = { $in: allowed };
    }

    return Branch.find(query).sort({ createdAt: 1 });
  }

  /**
   * Updates branch working hours, holidays, stations, googleReviewUrl, pettyCashFloatPaise.
   */
  async updateBranch(ctx: RequestContext, branchIdStr: string, updates: any): Promise<IBranch> {
    const branchId = toObjectId(branchIdStr);

    if (ctx.role === 'manager' && !ctx.branchIds.includes(branchIdStr)) {
      throw new AppError(403, 'FORBIDDEN', 'Access to branch denied');
    }

    const branch = await Branch.findOne({ _id: branchId, businessId: toObjectId(ctx.businessId!) });
    if (!branch) {
      throw new AppError(404, 'NOT_FOUND', 'Branch not found');
    }

    const before = branch.toObject();
    Object.assign(branch, updates);
    await branch.save();

    await auditService.logAction({
      ctx,
      action: 'branch.update',
      entity: 'branch',
      entityId: branch._id,
      branchId: branch._id,
      before,
      after: updates,
    });

    return branch;
  }

  /**
   * Owner creates a manager.
   */
  async createManager(ctx: RequestContext, data: any): Promise<SafeUser> {
    if (ctx.role !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only owner can create managers');
    }

    const email = data.email.trim().toLowerCase();
    const existing = await EmailRegistry.findById(email);
    if (existing) {
      throw new AppError(409, 'DUPLICATE_EMAIL', `Email ${email} is already in use`);
    }

    const businessId = toObjectId(ctx.businessId!);
    await assertRefsInBusiness(Branch, businessId, data.branchIds, 'branches');
    const passwordHash = await hashPassword(data.password);

    return withTransaction(async (session) => {
      const manager = new User({
        businessId,
        role: 'manager',
        name: data.name,
        email,
        phone: data.phone ? normalizePhone(data.phone) : undefined,
        passwordHash,
        branchIds: data.branchIds.map(toObjectId),
        flags: data.flags || {},
        staffId: data.staffId ? toObjectId(data.staffId) : undefined,
        status: 'active',
        sessionVersion: 0,
        failedLogins: 0,
      });
      await manager.save({ session });

      await new EmailRegistry({
        _id: email,
        kind: 'tenant',
        businessId,
        userId: manager._id,
      }).save({ session });

      await auditService.logAction({
        ctx,
        action: 'manager.create',
        entity: 'user',
        entityId: manager._id,
        after: { name: manager.name, email: manager.email, branchIds: manager.branchIds },
        session,
      });

      return toSafeUser(manager);
    });
  }

  /**
   * Owner updates manager's branches, flags, or status.
   */
  async updateManager(ctx: RequestContext, managerIdStr: string, updates: any): Promise<SafeUser> {
    if (ctx.role !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only owner can update managers');
    }

    const manager = await User.findOne({
      _id: toObjectId(managerIdStr),
      businessId: toObjectId(ctx.businessId!),
      role: 'manager',
    });
    if (!manager) {
      throw new AppError(404, 'NOT_FOUND', 'Manager not found');
    }

    const { passwordHash: _hash, ...before } = manager.toObject();

    if (updates.branchIds) {
      await assertRefsInBusiness(Branch, manager.businessId, updates.branchIds, 'branches');
    }
    const branchesChanged =
      !!updates.branchIds &&
      [...updates.branchIds].sort().join() !== manager.branchIds.map((b) => b.toString()).sort().join();
    const statusChanged = !!updates.status && updates.status !== manager.status;

    if (updates.branchIds) {
      manager.branchIds = updates.branchIds.map(toObjectId);
    }
    if (updates.flags) {
      manager.flags = { ...manager.flags, ...updates.flags };
    }
    if (updates.status) {
      manager.status = updates.status;
    }
    if (updates.staffId !== undefined) {
      manager.staffId = updates.staffId ? toObjectId(updates.staffId) : undefined;
    }

    await manager.save();

    // A branch reassignment or deactivation logs the manager out; flag changes apply on the next request
    if (branchesChanged || statusChanged) {
      await authService.revokeAllSessions(manager._id.toString());
    }

    await auditService.logAction({
      ctx,
      action: 'manager.update',
      entity: 'user',
      entityId: manager._id,
      before,
      after: updates,
    });

    return toSafeUser(manager);
  }

  /**
   * Gets managers for owner's business.
   */
  async getManagers(ctx: RequestContext): Promise<IUser[]> {
    if (ctx.role !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only owner can view managers list');
    }
    return User.find({ businessId: toObjectId(ctx.businessId!), role: 'manager' }).select('-passwordHash').sort({ createdAt: 1 });
  }

  /**
   * Gets branch login users.
   */
  async getBranchLogins(ctx: RequestContext): Promise<IUser[]> {
    const businessId = toObjectId(ctx.businessId!);
    const query: any = { businessId, role: 'branch' };
    if (ctx.role === 'manager') {
      query.branchIds = { $in: ctx.branchIds.map(toObjectId) };
    }
    return User.find(query).select('-passwordHash');
  }

  /**
   * Owner or manager updates branch login flags (markAttendance).
   */
  async updateBranchLoginFlags(ctx: RequestContext, branchLoginUserId: string, flags: { markAttendance: boolean }): Promise<SafeUser> {
    const branchUser = await User.findOne({
      _id: toObjectId(branchLoginUserId),
      businessId: toObjectId(ctx.businessId!),
      role: 'branch',
    });
    if (!branchUser) {
      throw new AppError(404, 'NOT_FOUND', 'Branch user not found');
    }

    if (ctx.role === 'manager') {
      const isAssigned = (ctx.branchIds || []).some((b: string) => branchUser.branchIds.map((id) => id.toString()).includes(b));
      if (!isAssigned) {
        throw new AppError(403, 'FORBIDDEN', 'Cannot modify branch logins of unassigned branches');
      }
    }

    branchUser.flags = { ...branchUser.flags, markAttendance: flags.markAttendance };
    await branchUser.save();

    await auditService.logAction({
      ctx,
      action: 'branch_login.flags_update',
      entity: 'user',
      entityId: branchUser._id,
      branchId: branchUser.branchLoginFor,
      after: flags,
    });

    return toSafeUser(branchUser);
  }
}

export const businessService = new BusinessService();
