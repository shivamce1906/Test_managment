import { Types } from 'mongoose';
import {
  Customer,
  Bill,
  Appointment,
  CustomerPlan,
  WalletLedger,
  LoyaltyLedger,
  Feedback,
  WaConversation,
  withTransaction,
  ICustomer,
} from '../models';
import { AppError, maskPhone, maskEmail, normalizePhone, getBusinessDate } from '../utils';
import { RequestContext, toObjectId } from './context';
import { auditService } from './audit.service';
import ExcelJS from 'exceljs';

export class CustomerService {
  /**
   * Creates a new customer with duplicate phone check.
   */
  async createCustomer(ctx: RequestContext, data: any): Promise<ICustomer> {
    const businessId = toObjectId(ctx.businessId!);
    const phone = normalizePhone(data.phone);

    const existing = await Customer.findOne({ businessId, phone });
    if (existing) {
      throw new AppError(409, 'DUPLICATE_PHONE', `Customer with phone ${phone} already exists`, {
        details: { customerId: existing._id },
      });
    }

    const customer = new Customer({
      businessId,
      name: data.name,
      phone,
      altPhones: (data.altPhones || []).map(normalizePhone),
      email: data.email,
      gender: data.gender,
      dob: data.dob,
      anniversary: data.anniversary,
      address: data.address,
      source: data.source || 'walk_in',
      referredBy: data.referredBy ? toObjectId(data.referredBy) : undefined,
      tags: data.tags || [],
      waOptIn: data.waOptIn !== undefined ? data.waOptIn : true,
      doNotMessage: data.doNotMessage !== undefined ? data.doNotMessage : false,
      notes: data.notes,
      stats: {
        visits: 0,
        spendPaise: 0,
        noShows: 0,
      },
      walletBalancePaise: 0,
      loyaltyPoints: 0,
      duePaise: 0,
    });

    await customer.save();

    await auditService.logAction({
      ctx,
      action: 'customer.create',
      entity: 'customer',
      entityId: customer._id,
      after: { name: customer.name, phone: maskPhone(customer.phone) },
    });

    return customer;
  }

  /**
   * Updates customer profile.
   */
  async updateCustomer(ctx: RequestContext, id: string, updates: any): Promise<ICustomer> {
    const businessId = toObjectId(ctx.businessId!);
    const customer = await Customer.findOne({ _id: toObjectId(id), businessId });
    if (!customer) {
      throw new AppError(404, 'NOT_FOUND', 'Customer not found');
    }

    if (updates.phone) {
      const newPhone = normalizePhone(updates.phone);
      if (newPhone !== customer.phone) {
        const existing = await Customer.findOne({ businessId, phone: newPhone });
        if (existing) {
          throw new AppError(409, 'DUPLICATE_PHONE', `Customer with phone ${newPhone} already exists`, {
            details: { customerId: existing._id },
          });
        }
        customer.phone = newPhone;
      }
    }

    const before = customer.toObject();
    Object.assign(customer, updates);
    if (updates.altPhones) {
      customer.altPhones = updates.altPhones.map(normalizePhone);
    }
    await customer.save();

    await auditService.logAction({
      ctx,
      action: 'customer.update',
      entity: 'customer',
      entityId: customer._id,
      before: { name: before.name, phone: maskPhone(before.phone) },
      after: { name: customer.name, phone: maskPhone(customer.phone) },
    });

    return customer;
  }

  /**
   * Adds service note (e.g. hair colour formula, skin type preferences).
   */
  async addServiceNote(ctx: RequestContext, id: string, note: { text: string; colourFormula?: string; staffId?: string }): Promise<ICustomer> {
    const businessId = toObjectId(ctx.businessId!);
    const customer = await Customer.findOne({ _id: toObjectId(id), businessId });
    if (!customer) {
      throw new AppError(404, 'NOT_FOUND', 'Customer not found');
    }

    const today = getBusinessDate(new Date());
    customer.serviceNotes.unshift({
      date: today,
      staffId: note.staffId ? toObjectId(note.staffId) : undefined,
      text: note.text,
      colourFormula: note.colourFormula,
    });

    // Cap at 200 service notes
    if (customer.serviceNotes.length > 200) {
      customer.serviceNotes = customer.serviceNotes.slice(0, 200);
    }

    await customer.save();
    return customer;
  }

  /**
   * Retrieves single customer with phone masking rules.
   * If reveal=true, unmasked phone is returned and phone_reveal audit log is written.
   */
  async getCustomer(ctx: RequestContext, id: string, reveal: boolean = false): Promise<any> {
    const businessId = toObjectId(ctx.businessId!);
    const customer = await Customer.findOne({ _id: toObjectId(id), businessId });
    if (!customer) {
      throw new AppError(404, 'NOT_FOUND', 'Customer not found');
    }

    const shouldMask = (ctx.role === 'manager' || ctx.role === 'branch') && !reveal;

    if (reveal && (ctx.role === 'manager' || ctx.role === 'branch')) {
      await auditService.logAction({
        ctx,
        action: 'customer.phone_reveal',
        entity: 'customer',
        entityId: customer._id,
        reason: 'Customer detail view with reveal',
      });
    }

    const obj: any = customer.toObject();
    if (shouldMask) {
      obj.phone = maskPhone(obj.phone);
      obj.altPhones = (obj.altPhones || []).map(maskPhone);
      obj.email = maskEmail(obj.email);
    }

    return obj;
  }

  /**
   * Searches and lists customers with masking for manager and branch logins.
   */
  async getCustomers(
    ctx: RequestContext,
    filters: {
      q?: string;
      tags?: string[];
      segment?: string;
      lastVisitFrom?: string;
      lastVisitTo?: string;
      page?: number;
      limit?: number;
    }
  ): Promise<{ customers: any[]; total: number }> {
    const businessId = toObjectId(ctx.businessId!);
    const query: any = { businessId, mergedInto: { $exists: false } };

    if (filters.q) {
      const normalized = filters.q.replace(/\D/g, '');
      if (normalized.length >= 4) {
        query.phone = { $regex: normalized };
      } else {
        query.name = { $regex: filters.q, $options: 'i' };
      }
    }

    if (filters.tags && filters.tags.length > 0) {
      query.tags = { $in: filters.tags };
    }

    if (filters.lastVisitFrom || filters.lastVisitTo) {
      query['stats.lastVisit'] = {};
      if (filters.lastVisitFrom) query['stats.lastVisit'].$gte = filters.lastVisitFrom;
      if (filters.lastVisitTo) query['stats.lastVisit'].$lte = filters.lastVisitTo;
    }

    // Segments filters
    if (filters.segment === 'new') {
      query['stats.visits'] = 1;
    } else if (filters.segment === 'regular') {
      query['stats.visits'] = { $gte: 3 };
    } else if (filters.segment === 'lapsed') {
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      query['stats.lastVisit'] = { $lt: getBusinessDate(sixtyDaysAgo) };
    }

    const page = Math.max(1, filters.page || 1);
    const limit = Math.min(100, Math.max(1, filters.limit || 25));
    const skip = (page - 1) * limit;

    const [customers, total] = await Promise.all([
      Customer.find(query).sort({ updatedAt: -1 }).skip(skip).limit(limit),
      Customer.countDocuments(query),
    ]);

    const shouldMask = ctx.role === 'manager' || ctx.role === 'branch';

    const maskedCustomers = customers.map((c) => {
      const obj: any = c.toObject();
      if (shouldMask) {
        obj.phone = maskPhone(obj.phone);
        obj.altPhones = (obj.altPhones || []).map(maskPhone);
        obj.email = maskEmail(obj.email);
      }
      return obj;
    });

    return { customers: maskedCustomers, total };
  }

  /**
   * Retrieves complete customer profile history across all tabs.
   */
  async getCustomerHistory(ctx: RequestContext, customerIdStr: string, type?: string): Promise<any> {
    const businessId = toObjectId(ctx.businessId!);
    const customerId = toObjectId(customerIdStr);

    const results: any = {};

    if (!type || type === 'bills') {
      results.bills = await Bill.find({ businessId, customerId }).sort({ businessDate: -1 });
    }
    if (!type || type === 'appointments') {
      results.appointments = await Appointment.find({ businessId, customerId }).sort({ start: -1 });
    }
    if (!type || type === 'plans') {
      results.plans = await CustomerPlan.find({ businessId, customerId }).sort({ validTill: -1 });
    }
    if (!type || type === 'wallet') {
      results.wallet = await WalletLedger.find({ businessId, customerId }).sort({ createdAt: -1 });
    }
    if (!type || type === 'loyalty') {
      results.loyalty = await LoyaltyLedger.find({ businessId, customerId }).sort({ createdAt: -1 });
    }
    if (!type || type === 'feedback') {
      results.feedback = await Feedback.find({ businessId, customerId }).sort({ createdAt: -1 });
    }
    if (!type || type === 'whatsapp') {
      results.conversations = await WaConversation.find({ businessId, customerId }).sort({ lastMessageAt: -1 });
    }

    return results;
  }

  /**
   * Merges two duplicate customer profiles into one.
   * Target profile keeps history; duplicate profile gets mergedInto target.
   * Duplicate phone is rewritten to merged:<dupId> so original phone is freed up.
   */
  async mergeCustomers(ctx: RequestContext, targetIdStr: string, duplicateIdStr: string): Promise<ICustomer> {
    if (ctx.role !== 'owner' && ctx.role !== 'manager') {
      throw new AppError(403, 'FORBIDDEN', 'Only owner or manager can merge customer profiles');
    }

    if (targetIdStr === duplicateIdStr) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Cannot merge customer into itself');
    }

    const businessId = toObjectId(ctx.businessId!);
    const targetId = toObjectId(targetIdStr);
    const duplicateId = toObjectId(duplicateIdStr);

    return withTransaction(async (session) => {
      const target = await Customer.findOne({ _id: targetId, businessId }).session(session);
      const duplicate = await Customer.findOne({ _id: duplicateId, businessId }).session(session);

      if (!target || !duplicate) {
        throw new AppError(404, 'NOT_FOUND', 'One or both customer profiles not found');
      }

      if (duplicate.mergedInto) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Duplicate customer has already been merged');
      }

      // 1. Move bills, appointments, customer plans, ledgers, dues, feedback, waConversations
      await Bill.updateMany({ businessId, customerId: duplicateId }, { $set: { customerId: targetId } }, { session });
      await Appointment.updateMany({ businessId, customerId: duplicateId }, { $set: { customerId: targetId } }, { session });
      await CustomerPlan.updateMany({ businessId, customerId: duplicateId }, { $set: { customerId: targetId } }, { session });
      await WalletLedger.updateMany({ businessId, customerId: duplicateId }, { $set: { customerId: targetId } }, { session });
      await LoyaltyLedger.updateMany({ businessId, customerId: duplicateId }, { $set: { customerId: targetId } }, { session });
      await Feedback.updateMany({ businessId, customerId: duplicateId }, { $set: { customerId: targetId } }, { session });
      await WaConversation.updateMany({ businessId, customerId: duplicateId }, { $set: { customerId: targetId } }, { session });

      // 2. Transfer wallet balance, loyalty points, dues, and stats to target
      target.walletBalancePaise += duplicate.walletBalancePaise;
      target.loyaltyPoints += duplicate.loyaltyPoints;
      target.duePaise += duplicate.duePaise;
      target.stats.visits += duplicate.stats.visits;
      target.stats.spendPaise += duplicate.stats.spendPaise;
      target.stats.noShows += duplicate.stats.noShows;

      // Add duplicate's phone to target's altPhones
      if (!target.altPhones.includes(duplicate.phone)) {
        target.altPhones.push(duplicate.phone);
      }

      // Append service notes
      target.serviceNotes = [...target.serviceNotes, ...duplicate.serviceNotes].slice(0, 200);

      await target.save({ session });

      // 3. Mark duplicate as merged and free phone number
      duplicate.mergedInto = targetId;
      duplicate.phone = `merged:${duplicate._id.toString()}`;
      await duplicate.save({ session });

      await auditService.logAction({
        ctx,
        action: 'customer.merge',
        entity: 'customer',
        entityId: target._id,
        reason: `Merged duplicate profile ${duplicateIdStr} into ${targetIdStr}`,
        before: { duplicateId: duplicateIdStr },
        after: { targetId: targetIdStr },
        session,
      });

      return target;
    });
  }

  /**
   * Exports customer directory to Excel (Owner only).
   */
  async exportCustomers(ctx: RequestContext): Promise<Buffer> {
    if (ctx.role !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only owner can export customer data');
    }

    const businessId = toObjectId(ctx.businessId!);
    const customers = await Customer.find({ businessId, mergedInto: { $exists: false } }).sort({ name: 1 });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Customers');

    sheet.columns = [
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Phone', key: 'phone', width: 16 },
      { header: 'Alt Phone', key: 'altPhone', width: 16 },
      { header: 'Email', key: 'email', width: 25 },
      { header: 'Gender', key: 'gender', width: 10 },
      { header: 'DOB', key: 'dob', width: 12 },
      { header: 'Anniversary', key: 'anniversary', width: 12 },
      { header: 'Visits', key: 'visits', width: 10 },
      { header: 'Total Spend (INR)', key: 'spend', width: 18 },
      { header: 'Wallet Balance (INR)', key: 'wallet', width: 20 },
      { header: 'Loyalty Points', key: 'loyalty', width: 15 },
      { header: 'Due Amount (INR)', key: 'due', width: 16 },
      { header: 'Tags', key: 'tags', width: 20 },
    ];

    customers.forEach((c) => {
      sheet.addRow({
        name: c.name,
        phone: c.phone,
        altPhone: c.altPhones.join(', '),
        email: c.email || '',
        gender: c.gender || '',
        dob: c.dob || '',
        anniversary: c.anniversary || '',
        visits: c.stats.visits,
        spend: (c.stats.spendPaise / 100).toFixed(2),
        wallet: (c.walletBalancePaise / 100).toFixed(2),
        loyalty: c.loyaltyPoints,
        due: (c.duePaise / 100).toFixed(2),
        tags: c.tags.join(', '),
      });
    });

    await auditService.logAction({
      ctx,
      action: 'customer.export',
      entity: 'customer',
      reason: 'Owner exported full customer list to Excel',
      after: { totalCount: customers.length },
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}

export const customerService = new CustomerService();
