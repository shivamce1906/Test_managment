import { Types, ClientSession } from 'mongoose';
import {
  Bill,
  BillVersion,
  Business,
  Branch,
  Customer,
  Service,
  Product,
  Plan,
  CustomerPlan,
  WalletLedger,
  LoyaltyLedger,
  StockMovement,
  StockBalance,
  Due,
  DueReceipt,
  DayClosure,
  Appointment,
  Counter,
  DailySummary,
  Staff,
  User,
  PayrollRun,
  withTransaction,
  IBill,
} from '../models';
import {
  AppError,
  getBusinessDate,
  getFinancialYear,
  generateRandomToken,
  logger,
  addDays,
} from '../utils';
import { RequestContext, toObjectId } from './context';
import { auditService } from './audit.service';
import { notificationService } from './notification.service';
import { computeBill, ComputeBillInput, ComputeLineItem } from './billing.compute';
import { pdfService } from '../integrations';

/** Statuses whose effects (stock, wallet, dues, stats, summary) have been applied. */
const EFFECTIVE_STATUSES = ['paid', 'partly_paid'];

/** Managers and branch logins may only touch bills of their own branches. */
function assertBillScope(ctx: RequestContext, bill: { branchId: Types.ObjectId }): void {
  if ((ctx.role === 'manager' || ctx.role === 'branch') && !ctx.branchIds.includes(bill.branchId.toString())) {
    throw new AppError(404, 'NOT_FOUND', 'Bill not found');
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** A locked or paid payroll month has paid out this bill's commission: the bill is frozen. */
async function assertPayrollOpen(bill: { businessId: Types.ObjectId; branchId: Types.ObjectId; businessDate: string }, session: ClientSession): Promise<void> {
  const locked = await PayrollRun.exists({
    businessId: bill.businessId,
    branchId: bill.branchId,
    month: bill.businessDate.slice(0, 7),
    status: { $in: ['locked', 'paid'] },
  }).session(session);
  if (locked) {
    throw new AppError(409, 'PAYROLL_LOCKED', `Payroll for ${bill.businessDate.slice(0, 7)} is locked; this bill can no longer be changed (refunds are still possible)`);
  }
}

export class BillingService {
  /**
   * Helper to format invoice sequence into standard Glox invoice number:
   * e.g. SRT1/2026-27/000123
   */
  private formatInvoiceNumber(prefix: string, fy: string, seq: number): string {
    const seqStr = String(seq).padStart(6, '0');
    return `${prefix}/${fy}/${seqStr}`;
  }

  /**
   * Generates next atomic invoice number for branch and financial year.
   */
  async getNextInvoiceNumber(
    businessId: Types.ObjectId,
    branchId: Types.ObjectId,
    invoicePrefix: string,
    fy: string,
    session?: ClientSession
  ): Promise<string> {
    const counterKey = `${businessId}:${branchId}:invoice:${fy}`;
    const counter = await Counter.findByIdAndUpdate(
      counterKey,
      { $inc: { seq: 1 } },
      { upsert: true, new: true, session }
    );
    return this.formatInvoiceNumber(invoicePrefix, fy, counter.seq);
  }

  /**
   * Generates next atomic receipt number for branch dues collection.
   */
  async getNextReceiptNumber(
    businessId: Types.ObjectId,
    branchId: Types.ObjectId,
    invoicePrefix: string,
    fy: string,
    session?: ClientSession
  ): Promise<string> {
    const counterKey = `${businessId}:${branchId}:receipt:${fy}`;
    const counter = await Counter.findByIdAndUpdate(
      counterKey,
      { $inc: { seq: 1 } },
      { upsert: true, new: true, session }
    );
    return `${invoicePrefix}/${fy}/RCP-${String(counter.seq).padStart(6, '0')}`;
  }

  /**
   * Previews a bill: the same validation and maths as saving it, without saving anything.
   */
  async previewBill(ctx: RequestContext, branchIdStr: string, draft: any): Promise<any> {
    const businessId = toObjectId(ctx.businessId!);
    const branchId = toObjectId(branchIdStr);

    const business = await Business.findById(businessId);
    if (!business) throw new AppError(404, 'NOT_FOUND', 'Business not found');

    let customer: any = { _id: null, loyaltyPoints: 0, walletBalancePaise: 0 };
    if (draft.customerId) {
      customer = await Customer.findOne({ _id: toObjectId(draft.customerId), businessId });
      if (!customer) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
    } else if ((draft.redemptions || []).length || (draft.collectDues || []).length) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Choose the customer before redeeming plans or collecting dues', {
        fields: { customerId: 'Required for redemptions and dues' },
      });
    }

    const prepared = await this.prepareDraft(ctx, business, branchId, customer, draft, undefined, { preview: true });
    const payablePaise = prepared.computed.totals.totalPaise + prepared.computed.totals.totalTipsPaise + prepared.collectTotalPaise;

    return {
      payablePaise,
      totals: prepared.computed.totals,
      lines: prepared.computed.lines,
      redemptions: prepared.redemptions,
      tips: prepared.tips,
      collectDuesPaise: prepared.collectTotalPaise,
      needsApproval: prepared.approvalReasons.length > 0 && ctx.role !== 'owner',
      approvalReasons: prepared.approvalReasons,
    };
  }

  /**
   * Checks whether the requested discounts exceed the user's role limits.
   */
  private checkDiscountLimit(ctx: RequestContext, business: any, draft: any, computed: any): boolean {
    if (ctx.role === 'owner') return false; // Owner has unlimited discount authority

    let allowedBps = business.discountLimits.branchBps ?? 1000;
    if (ctx.role === 'manager') {
      // A manager's personal cap (flags.maxDiscountBps) overrides the business-wide limit
      allowedBps = ctx.flags?.maxDiscountBps ?? business.discountLimits.managerBps ?? 2000;
    }

    // Check whole-bill discount
    if (draft.billDiscount) {
      if (draft.billDiscount.type === 'pct' && draft.billDiscount.value > allowedBps) {
        return true;
      }
      if (draft.billDiscount.type === 'amount') {
        const pctBps = Math.round((draft.billDiscount.value * 10000) / (computed.totals.grossPaise || 1));
        if (pctBps > allowedBps) return true;
      }
    }

    // Check line discounts
    for (const l of computed.lines) {
      if (l.lineDiscount) {
        if (l.lineDiscount.type === 'pct' && l.lineDiscount.value > allowedBps) {
          return true;
        }
        if (l.lineDiscount.type === 'amount') {
          const gross = l.unitPricePaise * l.qty;
          const pctBps = Math.round((l.lineDiscount.value * 10000) / (gross || 1));
          if (pctBps > allowedBps) return true;
        }
      }
    }

    return false;
  }

  /**
   * Resolves bill lines: price for the branch, staff (this business only, names snapshotted),
   * commission rule (the service's, else the staff member's default) and consumable cost.
   */
  private async resolveInputLines(
    businessId: Types.ObjectId,
    branchId: Types.ObjectId,
    rawLines: any[],
    session?: ClientSession
  ): Promise<ComputeLineItem[]> {
    const inputLines: ComputeLineItem[] = [];

    const staffIds = [...new Set(rawLines.flatMap((l: any) => (l.staff || []).map((st: any) => String(st.staffId))))];
    const staffDocs = staffIds.length
      ? await Staff.find({ businessId, _id: { $in: staffIds.map(toObjectId) } }).session(session || null)
      : [];
    if (staffDocs.length !== staffIds.length) {
      throw new AppError(404, 'NOT_FOUND', 'One or more staff on the bill were not found in this business');
    }
    const staffById = new Map(staffDocs.map((st) => [st._id.toString(), st]));
    const staffOf = (st: any) => staffById.get(String(st.staffId))!;

    for (const raw of rawLines) {
      const refId = toObjectId(raw.refId);

      if (raw.kind === 'service') {
        const svc = await Service.findOne({ _id: refId, businessId, active: true }).session(session || null);
        if (!svc) throw new AppError(404, 'NOT_FOUND', `Service ${raw.refId} not found`);

        const bp = svc.branchPrices.find((p) => p.branchId.equals(branchId));
        if (bp && bp.active === false) {
          throw new AppError(422, 'SERVICE_UNAVAILABLE', `${svc.name} is not offered in this branch`);
        }
        const unitPricePaise = bp && bp.pricePaise != null ? bp.pricePaise : svc.basePricePaise;
        const serviceRule = svc.commission?.type ? svc.commission : undefined;

        const staff = (raw.staff || []).map((st: any) => {
          const doc = staffOf(st);
          const ownRule = doc.commission?.service?.type ? doc.commission.service : undefined;
          return { staffId: doc._id, name: doc.name, splitBps: st.splitBps, rule: serviceRule || ownRule };
        });

        // Consumable cost = purchase price per use-unit × quantity used
        const consumableIds = (svc.consumables || []).map((c) => c.productId);
        const consumableDocs = consumableIds.length
          ? await Product.find({ businessId, _id: { $in: consumableIds } }).session(session || null)
          : [];
        const costPerUnit = new Map(
          consumableDocs.map((p) => [p._id.toString(), (p.purchasePricePaise || 0) / (p.unitsPerPurchase || 1)])
        );

        inputLines.push({
          _id: raw._id ? toObjectId(raw._id) : new Types.ObjectId(),
          kind: 'service',
          refId,
          name: svc.name,
          hsnSac: '9983',
          qty: raw.qty || 1,
          unitPricePaise,
          lineDiscount: raw.lineDiscount,
          staff,
          consumablesUsed: (svc.consumables || []).map((c) => {
            const qty = c.qty * (raw.qty || 1);
            return { productId: c.productId, qty, costPaise: Math.round((costPerUnit.get(c.productId.toString()) || 0) * qty) };
          }),
        });
      } else if (raw.kind === 'product') {
        const prod = await Product.findOne({ _id: refId, businessId, active: true }).session(session || null);
        if (!prod) throw new AppError(404, 'NOT_FOUND', `Product ${raw.refId} not found`);
        if (prod.type === 'consumable') {
          throw new AppError(422, 'VALIDATION_ERROR', `${prod.name} is a consumable and cannot be sold`);
        }

        const unitPricePaise = prod.sellingPricePaise || prod.mrpPaise || 0;
        const staff = (raw.staff || []).map((st: any) => {
          const doc = staffOf(st);
          return { staffId: doc._id, name: doc.name, splitBps: st.splitBps || 10000, productBps: doc.commission?.productBps || 0 };
        });

        inputLines.push({
          _id: raw._id ? toObjectId(raw._id) : new Types.ObjectId(),
          kind: 'product',
          refId,
          name: prod.name,
          hsnSac: prod.hsn || '3305',
          qty: raw.qty || 1,
          unitPricePaise,
          lineDiscount: raw.lineDiscount,
          staff,
          gstBps: prod.gstBps,
        });
      } else if (raw.kind === 'membership' || raw.kind === 'package' || raw.kind === 'wallet_topup' || raw.kind === 'voucher') {
        const plan = await Plan.findOne({ _id: refId, businessId, active: true }).session(session || null);
        if (!plan) throw new AppError(404, 'NOT_FOUND', `Plan ${raw.refId} not found`);

        inputLines.push({
          _id: raw._id ? toObjectId(raw._id) : new Types.ObjectId(),
          kind: raw.kind,
          refId,
          name: plan.name,
          qty: 1,
          unitPricePaise: plan.pricePaise,
          lineDiscount: raw.lineDiscount,
        });
      }
    }

    return inputLines;
  }

  /**
   * Everything a bill needs before it is saved (used by preview, create and edit): lines,
   * staff splits, redemptions valued by the server, tips, dues being collected, payment checks,
   * totals and approval reasons.
   */
  private async prepareDraft(
    ctx: RequestContext,
    business: any,
    branchId: Types.ObjectId,
    customer: any,
    draft: any,
    session?: ClientSession,
    opts: { allowOverpay?: boolean; preview?: boolean } = {}
  ): Promise<{
    inputLines: ComputeLineItem[];
    redemptions: any[];
    tips: any[];
    collectDues: { due: any; amountPaise: number }[];
    collectTotalPaise: number;
    computed: ReturnType<typeof computeBill>;
    approvalReasons: ('discount_over_limit' | 'partly_paid')[];
  }> {
    const businessId = toObjectId(business._id);
    const inputLines = await this.resolveInputLines(businessId, branchId, draft.lines, session);

    // Staff splits on a line must add up to 100 %
    for (const l of inputLines) {
      if (l.staff && l.staff.length > 0) {
        const total = sum(l.staff.map((st) => st.splitBps || 0));
        if (total !== 10000) {
          throw new AppError(422, 'SPLIT_INVALID', `Staff splits for line ${l.name} must total 10000 bps (100%)`);
        }
      }
    }

    // Redemptions (amounts are always computed here, never taken from the client)
    const today = getBusinessDate();
    const assertUsable = (plan: any, label: string) => {
      if (plan.validTill < today || plan.validFrom > today) {
        throw new AppError(422, 'PLAN_INACTIVE', `${label} is not valid today (valid ${plan.validFrom} to ${plan.validTill})`);
      }
      const scope = (plan.planSnap?.branchScope || []).map(String);
      if (scope.length > 0 && !scope.includes(branchId.toString())) {
        throw new AppError(422, 'PLAN_OUT_OF_SCOPE', `${label} cannot be used in this branch`);
      }
    };
    const redemptions: any[] = [];
    for (const red of draft.redemptions || []) {
      if (red.kind === 'package') {
        const plan = await CustomerPlan.findOne({
          _id: toObjectId(red.refId),
          businessId,
          customerId: customer._id,
          status: 'active',
        }).session(session || null);
        if (!plan) throw new AppError(422, 'PLAN_INACTIVE', 'Package plan not found or inactive');
        assertUsable(plan, 'This package');

        const lineIdx = red.lineId !== undefined ? Number(red.lineId) : 0;
        const targetLine = inputLines[lineIdx];
        if (!targetLine) throw new AppError(422, 'NO_SESSIONS_LEFT', 'Invalid lineId for package redemption');

        const sessionEntry = (plan.sessions || []).find((x) => x.serviceId.equals(targetLine.refId));
        if (!sessionEntry || sessionEntry.used >= sessionEntry.total) {
          throw new AppError(422, 'NO_SESSIONS_LEFT', 'No package sessions remaining for this service');
        }

        redemptions.push({
          kind: 'package',
          refId: plan._id,
          lineId: targetLine._id,
          amountPaise: targetLine.unitPricePaise * targetLine.qty,
          perSessionValuePaise: sessionEntry.perSessionValuePaise,
        });
      } else if (red.kind === 'membership') {
        const plan = await CustomerPlan.findOne({
          _id: toObjectId(red.refId),
          businessId,
          customerId: customer._id,
          status: 'active',
        }).session(session || null);
        if (!plan) throw new AppError(422, 'PLAN_INACTIVE', 'Membership not found or inactive');
        assertUsable(plan, 'This membership');

        redemptions.push({
          kind: 'membership',
          refId: plan._id,
          membershipDiscountBps: plan.planSnap?.membership?.serviceDiscountBps || 0,
          amountPaise: 0,
        });
      } else if (red.kind === 'voucher') {
        // Gift vouchers can be used by whoever holds the code; once only
        const voucher = await CustomerPlan.findOne({ _id: toObjectId(red.refId), businessId, 'planSnap.type': 'voucher' }).session(session || null);
        if (!voucher || voucher.status !== 'active') {
          throw new AppError(422, 'PLAN_INACTIVE', voucher ? `This voucher is ${voucher.status.replace('_', ' ')}` : 'Voucher not found');
        }
        assertUsable(voucher, 'This voucher');
        redemptions.push({ kind: 'voucher', refId: voucher._id, amountPaise: voucher.planSnap?.voucher?.valuePaise || 0 });
      } else if (red.kind === 'loyalty') {
        const loyalty = business.loyalty || {};
        const points = red.points || 0;
        if (!loyalty.enabled) {
          throw new AppError(422, 'VALIDATION_ERROR', 'Loyalty is switched off for this business');
        }
        if (points < (loyalty.minRedeem || 0)) {
          throw new AppError(422, 'VALIDATION_ERROR', `At least ${loyalty.minRedeem} points are needed to redeem`);
        }
        if (customer.loyaltyPoints < points) {
          throw new AppError(422, 'INSUFFICIENT_WALLET', 'Insufficient loyalty points');
        }
        redemptions.push({
          kind: 'loyalty',
          refId: customer._id,
          points,
          amountPaise: points * (loyalty.redeemValuePaise || 0),
        });
      }
    }

    // Tips: staff of this business, name snapshotted
    const tipStaffIds = [...new Set((draft.tips || []).map((t: any) => String(t.staffId)))] as string[];
    const tipStaff = tipStaffIds.length
      ? await Staff.find({ businessId, _id: { $in: tipStaffIds.map(toObjectId) } }).session(session || null)
      : [];
    if (tipStaff.length !== tipStaffIds.length) {
      throw new AppError(404, 'NOT_FOUND', 'Tip staff member not found in this business');
    }
    const tipName = new Map(tipStaff.map((st) => [st._id.toString(), st.name]));
    const tips = (draft.tips || []).map((t: any) => ({
      staffId: toObjectId(t.staffId),
      staffName: tipName.get(String(t.staffId))!,
      amountPaise: t.amountPaise,
      payout: t.payout,
    }));

    // Old dues collected on this bill: must be this customer's, open, and not over-collected
    const collectDues: { due: any; amountPaise: number }[] = [];
    for (const item of draft.collectDues || []) {
      const due = await Due.findOne({ _id: toObjectId(item.dueId), businessId, customerId: customer._id, status: 'open' }).session(session || null);
      if (!due) throw new AppError(404, 'NOT_FOUND', 'Due not found or already settled');
      if (item.amountPaise > due.amountPaise - due.settledPaise) {
        throw new AppError(422, 'VALIDATION_ERROR', 'Cannot collect more than the outstanding due');
      }
      collectDues.push({ due, amountPaise: item.amountPaise });
    }
    const collectTotalPaise = sum(collectDues.map((c) => c.amountPaise));

    const payments = draft.payments || [];
    const walletPaid = sum(payments.filter((p: any) => p.mode === 'wallet').map((p: any) => p.amountPaise));
    if (walletPaid > 0 && customer.walletBalancePaise < walletPaid) {
      throw new AppError(422, 'INSUFFICIENT_WALLET', 'Insufficient wallet balance');
    }

    const computed = computeBill({
      lines: inputLines,
      billDiscount: draft.billDiscount,
      redemptions,
      tips,
      payments,
      gstApplied: business.gst.enabled,
      businessGstBps: business.gst.rateBps || 1800,
    });

    // Payments cover the bill (total + tips) and any dues collected with it; never more
    const payablePaise = computed.totals.totalPaise + computed.totals.totalTipsPaise;
    const paidPaise = sum(payments.map((p: any) => p.amountPaise));
    // A preview reports payablePaise instead of rejecting a payment split that is still being typed
    if (!opts.allowOverpay && !opts.preview && paidPaise > payablePaise + collectTotalPaise) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Payments are more than the amount payable', {
        details: { payablePaise: payablePaise + collectTotalPaise, paidPaise },
      });
    }
    if (!opts.preview && collectTotalPaise > 0 && paidPaise < payablePaise + collectTotalPaise) {
      throw new AppError(422, 'VALIDATION_ERROR', 'To collect old dues on this bill, payments must cover the bill and those dues in full', {
        details: { payablePaise: payablePaise + collectTotalPaise, paidPaise },
      });
    }
    computed.totals.paidPaise = paidPaise - collectTotalPaise;
    computed.totals.duePaise = Math.max(0, payablePaise - computed.totals.paidPaise);

    const approvalReasons: ('discount_over_limit' | 'partly_paid')[] = [];
    if (computed.totals.duePaise > 0) approvalReasons.push('partly_paid');
    if (this.checkDiscountLimit(ctx, business, draft, computed)) approvalReasons.push('discount_over_limit');

    return { inputLines, redemptions, tips, collectDues, collectTotalPaise, computed, approvalReasons };
  }

  /**
   * Saves a bill inside a MongoDB transaction with atomic numbering and effects. The same
   * Idempotency-Key always returns the same bill, even when two requests race.
   */
  async createBill(
    ctx: RequestContext,
    branchIdStr: string,
    draft: any,
    idempotencyKey?: string
  ): Promise<IBill> {
    const businessId = toObjectId(ctx.businessId!);
    const branchId = toObjectId(branchIdStr);
    const key = idempotencyKey || draft.idempotencyKey || generateRandomToken(16);

    const existingBill = await Bill.findOne({ businessId, idempotencyKey: key });
    if (existingBill) {
      return existingBill;
    }

    let bill: IBill;
    try {
      bill = await withTransaction(async (session) => this.createBillTx(ctx, businessId, branchId, branchIdStr, draft, key, session));
    } catch (err: any) {
      // A parallel request with the same key won the race (unique businessId + idempotencyKey)
      if (err?.code === 11000 && err?.keyPattern?.idempotencyKey) {
        const winner = await Bill.findOne({ businessId, idempotencyKey: key });
        if (winner) return winner;
      }
      throw err;
    }

    await this.alertOwnerOnBigDiscount(ctx, bill).catch((err) => logger.warn({ err }, 'Owner discount alert failed'));
    return bill;
  }

  private async createBillTx(
    ctx: RequestContext,
    businessId: Types.ObjectId,
    branchId: Types.ObjectId,
    branchIdStr: string,
    draft: any,
    key: string,
    session: ClientSession
  ): Promise<IBill> {
    const business = await Business.findById(businessId).session(session);
    if (!business || business.status === 'suspended') {
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'Business is suspended');
    }

    const branch = await Branch.findOne({ _id: branchId, businessId }).session(session);
    if (!branch || branch.status === 'deactivated') {
      throw new AppError(422, 'BRANCH_INACTIVE', 'Branch is deactivated');
    }

    const businessDate = getBusinessDate(new Date());

    const closure = await DayClosure.findOne({ businessId, branchId, businessDate }).session(session);
    if (closure && closure.status === 'approved') {
      throw new AppError(409, 'DAY_CLOSED', `Branch day ${businessDate} has been closed and approved`);
    }

    const customer = await Customer.findOne({ _id: toObjectId(draft.customerId), businessId }).session(session);
    if (!customer) throw new AppError(404, 'NOT_FOUND', 'Customer not found');

    // Billed by: required for branch logins (a receptionist of this branch); optional otherwise
    let billedByName = ctx.name;
    let billedByStaffId: Types.ObjectId | undefined;
    if (ctx.role === 'branch' && !draft.billedByStaffId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'billedByStaffId is required for bills created by branch login', {
        fields: { billedByStaffId: 'Choose who is billing' },
      });
    }
    if (draft.billedByStaffId) {
      // Branch login: a receptionist of this branch. Owner/manager: any active staff of the business.
      const billedBy = await Staff.findOne({
        _id: toObjectId(draft.billedByStaffId),
        businessId,
        status: 'active',
        ...(ctx.role === 'branch' ? { branchId, designation: 'receptionist' } : {}),
      }).session(session);
      if (!billedBy) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Billed by must be an active receptionist of this branch', {
          fields: { billedByStaffId: 'Not an active receptionist of this branch' },
        });
      }
      billedByStaffId = billedBy._id;
      billedByName = billedBy.name;
    }

    if (draft.appointmentId) {
      const apt = await Appointment.findOne({ _id: toObjectId(draft.appointmentId), businessId, branchId, customerId: customer._id }).session(session);
      if (!apt) throw new AppError(404, 'NOT_FOUND', 'Appointment not found for this customer and branch');
      if (['billed', 'cancelled', 'no_show'].includes(apt.status)) {
        throw new AppError(422, 'INVALID_TRANSITION', `A ${apt.status} appointment cannot be billed`);
      }
    }

    const prepared = await this.prepareDraft(ctx, business, branchId, customer, draft, session);
    const { computed, approvalReasons } = prepared;

    let status: 'awaiting_approval' | 'paid' | 'partly_paid' = computed.totals.duePaise > 0 ? 'partly_paid' : 'paid';
    if (approvalReasons.length > 0 && ctx.role !== 'owner') {
      status = 'awaiting_approval';
    }

    const fy = getFinancialYear(new Date(), business.fyStartMonth);
    const invoiceNo = await this.getNextInvoiceNumber(businessId, branchId, branch.invoicePrefix, fy, session);

    const bill = new Bill({
      businessId,
      branchId,
      invoiceNo,
      fy,
      businessDate,
      customerId: customer._id,
      customerSnap: { name: customer.name, phone: customer.phone },
      billedByStaffId,
      billedByName,
      appointmentId: draft.appointmentId ? toObjectId(draft.appointmentId) : undefined,
      gstApplied: business.gst.enabled,
      pricesInclusive: business.gst.pricesInclusive,
      lines: computed.lines,
      billDiscount: draft.billDiscount,
      redemptions: prepared.redemptions,
      totals: computed.totals,
      payments: (draft.payments || []).map((p: any) => ({
        mode: p.mode,
        amountPaise: p.amountPaise,
        businessDate,
        tenderedPaise: p.tenderedPaise,
        ref: p.ref,
        at: new Date(),
      })),
      tips: prepared.tips,
      status,
      approval: status === 'awaiting_approval' ? { reasons: approvalReasons, requestedAt: new Date() } : undefined,
      version: 1,
      refunds: [],
      idempotencyKey: key,
    });

    await bill.save({ session });

    // Effects apply now for a paid/partly paid bill, or later when an approver approves it
    if (status === 'paid' || status === 'partly_paid') {
      await this.applyBillEffects(businessId, branchId, bill, customer, prepared.collectDues, session, toObjectId(ctx.userId));
    }

    await auditService.logAction({
      ctx,
      action: 'bill.create',
      entity: 'bill',
      entityId: bill._id,
      branchId,
      billedByName,
      after: { invoiceNo: bill.invoiceNo, totalPaise: bill.totals.totalPaise, status: bill.status },
      session,
    });

    await notificationService.bumpScope(businessId.toString(), `bills:${branchIdStr}`);
    if (draft.appointmentId) {
      await notificationService.bumpScope(businessId.toString(), `appointments:${branchIdStr}:${businessDate}`);
    }

    return bill;
  }

  /**
   * Notifies the owner when a manager or branch login's bill discount is above ownerAlertBps.
   */
  private async alertOwnerOnBigDiscount(ctx: RequestContext, bill: IBill): Promise<void> {
    if (ctx.role === 'owner' || bill.totals.grossPaise <= 0) return;
    const business = await Business.findById(bill.businessId).select('discountLimits');
    const alertBps = business?.discountLimits?.ownerAlertBps;
    if (!alertBps) return;
    const discountBps = Math.round((bill.totals.discountPaise * 10000) / bill.totals.grossPaise);
    if (discountBps <= alertBps) return;

    const owner = await User.findOne({ businessId: bill.businessId, role: 'owner', status: 'active' }).select('_id');
    if (!owner) return;
    await notificationService.createNotification({
      businessId: bill.businessId,
      userId: owner._id,
      type: 'bill.discount_alert',
      title: `Discount ${(discountBps / 100).toFixed(1)}% on ${bill.invoiceNo}`,
      body: `${bill.billedByName || ctx.name} gave ₹${(bill.totals.discountPaise / 100).toFixed(2)} off ₹${(bill.totals.grossPaise / 100).toFixed(2)} for ${bill.customerSnap?.name || 'a customer'}.`,
      link: `/bills/${bill._id}`,
    });
  }

  /**
   * Applies all financial, stock, customer, and summary effects when a bill is paid.
   */
  async applyBillEffects(
    businessId: Types.ObjectId,
    branchId: Types.ObjectId,
    bill: IBill,
    customer: any,
    collectDues?: { due: any; amountPaise: number }[],
    session?: ClientSession,
    userId?: Types.ObjectId
  ): Promise<void> {
    const businessDate = bill.businessDate;
    const actorId = userId || bill.billedByStaffId || businessId;
    const business = await Business.findById(businessId).select('loyalty').session(session || null);

    // 1. Consume package sessions (re-checked here: two bills racing for the last session conflict
    // on this document, the transaction retries, and the loser gets NO_SESSIONS_LEFT)
    for (const red of bill.redemptions) {
      if (red.kind === 'package') {
        const line = bill.lines.find((l) => l._id && red.lineId && l._id.equals(red.lineId));
        const plan = line && (await CustomerPlan.findOne({ _id: red.refId, businessId }).session(session || null));
        const entry = plan?.sessions?.find((x) => x.serviceId.equals(line!.refId));
        if (!plan || !entry || entry.used >= entry.total) {
          throw new AppError(422, 'NO_SESSIONS_LEFT', 'No package sessions remaining for this service');
        }
        entry.used += 1;
        if (plan.sessions!.every((x) => x.used >= x.total)) plan.status = 'used_up';
        plan.log.push({ action: 'redeem', at: new Date(), by: actorId, detail: { billId: bill._id, serviceId: line!.refId } });
        await plan.save({ session });
      } else if (red.kind === 'voucher') {
        const res = await CustomerPlan.updateOne(
          { _id: red.refId, businessId, status: 'active' },
          { $set: { status: 'used_up' }, $push: { log: { action: 'redeem', at: new Date(), by: actorId, detail: { billId: bill._id } } } },
          { session }
        );
        if (res.modifiedCount === 0) throw new AppError(422, 'PLAN_INACTIVE', 'This voucher has already been used');
      } else if (red.kind === 'loyalty') {
        if (red.points) {
          customer.loyaltyPoints = Math.max(0, customer.loyaltyPoints - red.points);
          await new LoyaltyLedger({
            businessId,
            customerId: customer._id,
            type: 'redeem',
            points: -red.points,
            billId: bill._id,
            balanceAfter: customer.loyaltyPoints,
          }).save({ session });
        }
      }
    }

    // 2. Post wallet payment deduction
    const walletPayment = bill.payments.find((p) => p.mode === 'wallet');
    if (walletPayment && walletPayment.amountPaise > 0) {
      // Conditional decrement
      const res = await Customer.updateOne(
        { _id: customer._id, businessId, walletBalancePaise: { $gte: walletPayment.amountPaise } },
        { $inc: { walletBalancePaise: -walletPayment.amountPaise } },
        { session }
      );
      if (res.matchedCount === 0) {
        throw new AppError(422, 'INSUFFICIENT_WALLET', 'Insufficient wallet balance for redemption');
      }

      customer.walletBalancePaise -= walletPayment.amountPaise;

      await new WalletLedger({
        businessId,
        customerId: customer._id,
        branchId,
        type: 'redeem',
        amountPaise: -walletPayment.amountPaise,
        billId: bill._id,
        balanceAfterPaise: customer.walletBalancePaise,
      }).save({ session });
    }

    // 3. Process sold lines (memberships, packages, wallet top-ups, vouchers)
    for (const l of bill.lines) {
      if (l.kind === 'membership' || l.kind === 'package' || l.kind === 'voucher') {
        const plan = await Plan.findOne({ _id: l.refId, businessId }).session(session || null);
        if (plan) {
          let voucherCode: string | undefined;
          if (l.kind === 'voucher') {
            // GV-XXXXXXXX from an alphabet without look-alike characters; unique per business
            const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            do {
              voucherCode = 'GV-' + Array.from({ length: 8 }, () => alphabet[parseInt(generateRandomToken(1), 16) % alphabet.length]).join('');
            } while (await CustomerPlan.exists({ businessId, voucherCode }).session(session || null));
          }

          const customerPlan = new CustomerPlan({
            businessId,
            customerId: customer._id,
            planId: plan._id,
            planSnap: plan.toObject(),
            soldBillId: bill._id,
            soldBranchId: branchId,
            validFrom: businessDate,
            validTill: addDays(businessDate, plan.validityDays),
            sessions:
              l.kind === 'package'
                ? (plan.package?.items || []).map((item) => ({
                    serviceId: item.serviceId,
                    total: item.sessions,
                    used: 0,
                    perSessionValuePaise: Math.round(plan.pricePaise / item.sessions),
                  }))
                : undefined,
            voucherCode,
            status: 'active',
            log: [
              {
                action: 'sold',
                at: new Date(),
                by: actorId,
                detail: { soldBillId: bill._id },
              },
            ],
          });
          await customerPlan.save({ session });
        }
      } else if (l.kind === 'wallet_topup') {
        const plan = await Plan.findOne({ _id: l.refId, businessId }).session(session || null);
        const creditPaise = plan?.walletOffer?.creditPaise || l.unitPricePaise;
        const paidPaise = l.unitPricePaise;
        const bonusPaise = Math.max(0, creditPaise - paidPaise);

        // Add to customer wallet balance
        customer.walletBalancePaise += creditPaise;
        await Customer.updateOne(
          { _id: customer._id, businessId },
          { $inc: { walletBalancePaise: creditPaise } },
          { session }
        );

        // Post topup ledger
        await new WalletLedger({
          businessId,
          customerId: customer._id,
          branchId,
          type: 'topup',
          amountPaise: paidPaise,
          billId: bill._id,
          balanceAfterPaise: customer.walletBalancePaise - bonusPaise,
        }).save({ session });

        // Post bonus ledger if any
        if (bonusPaise > 0) {
          await new WalletLedger({
            businessId,
            customerId: customer._id,
            branchId,
            type: 'bonus',
            amountPaise: bonusPaise,
            billId: bill._id,
            balanceAfterPaise: customer.walletBalancePaise,
          }).save({ session });
        }
      } else if (l.kind === 'product') {
        // Retail product stock deduction, at purchase cost (for margin reports)
        const prod = await Product.findOne({ _id: l.refId, businessId }).select('purchasePricePaise unitsPerPurchase').session(session || null);
        const unitCost = prod ? (prod.purchasePricePaise || 0) / (prod.unitsPerPurchase || 1) : 0;
        await new StockMovement({
          businessId,
          branchId,
          productId: l.refId,
          pool: 'retail',
          type: 'sale',
          qty: -l.qty,
          costPaise: Math.round(unitCost * l.qty),
          refType: 'bill',
          refId: bill._id,
          businessDate,
        }).save({ session });

        await StockBalance.findOneAndUpdate(
          { businessId, branchId, productId: l.refId, pool: 'retail' },
          { $inc: { qty: -l.qty }, $set: { lastMovementAt: new Date() } },
          { upsert: true, session }
        );
      } else if (l.kind === 'service' && l.consumablesUsed) {
        // Auto-deduct consumables used in service (BR-07)
        for (const c of l.consumablesUsed) {
          await new StockMovement({
            businessId,
            branchId,
            productId: c.productId,
            pool: 'consumable',
            type: 'service_use',
            qty: -c.qty,
            costPaise: c.costPaise || 0,
            refType: 'bill',
            refId: bill._id,
            businessDate,
          }).save({ session });

          await StockBalance.findOneAndUpdate(
            { businessId, branchId, productId: c.productId, pool: 'consumable' },
            { $inc: { qty: -c.qty }, $set: { lastMovementAt: new Date() } },
            { upsert: true, session }
          );
        }
      }
    }

    // 4. Handle due amount
    if (bill.totals.duePaise > 0) {
      await new Due({
        businessId,
        branchId,
        customerId: customer._id,
        billId: bill._id,
        amountPaise: bill.totals.duePaise,
        settledPaise: 0,
        status: 'open',
        settlements: [],
      }).save({ session });

      customer.duePaise += bill.totals.duePaise;
    }

    // 5. Settle old dues collected on this bill (validated and fully paid in prepareDraft)
    for (const item of collectDues || []) {
      const due = item.due;
      due.settledPaise += item.amountPaise;
      if (due.settledPaise >= due.amountPaise) {
        due.status = 'settled';
      }
      due.settlements.push({ billId: bill._id, amountPaise: item.amountPaise, at: new Date() });
      await due.save({ session });
      customer.duePaise = Math.max(0, customer.duePaise - item.amountPaise);
    }

    // 5b. Loyalty: earnPer100 points per full ₹100 of the bill total
    const loyalty = business?.loyalty;
    if (loyalty?.enabled && loyalty.earnPer100) {
      const earned = Math.floor(bill.totals.totalPaise / 10000) * loyalty.earnPer100;
      if (earned > 0) {
        customer.loyaltyPoints += earned;
        await new LoyaltyLedger({
          businessId,
          customerId: customer._id,
          type: 'earn',
          points: earned,
          billId: bill._id,
          balanceAfter: customer.loyaltyPoints,
        }).save({ session });
      }
    }

    // 6. Update appointment status if linked
    if (bill.appointmentId) {
      await Appointment.updateOne(
        { _id: bill.appointmentId, businessId },
        {
          $set: { status: 'billed', billId: bill._id },
          $push: {
            statusLog: {
              status: 'billed',
              at: new Date(),
              by: actorId,
              reason: `Bill ${bill.invoiceNo} raised`,
            },
          },
        },
        { session }
      );
    }

    // 7. Update customer statistics
    customer.stats.visits += 1;
    customer.stats.spendPaise += bill.totals.totalPaise;
    customer.stats.lastVisit = businessDate;
    if (!customer.stats.firstVisit) {
      customer.stats.firstVisit = businessDate;
    }

    await customer.save({ session });

    // 8. Update DailySummary (upsert using $inc)
    const summaryId = `${branchId.toString()}:${businessDate}`;
    const collectionsInc: any = {};
    for (const p of bill.payments) {
      collectionsInc[`collections.${p.mode}`] = (collectionsInc[`collections.${p.mode}`] || 0) + p.amountPaise;
    }

    let servicesPaise = 0;
    let productsPaise = 0;
    let plansPaise = 0;
    for (const l of bill.lines) {
      if (l.kind === 'service') servicesPaise += l.totalPaise;
      else if (l.kind === 'product') productsPaise += l.totalPaise;
      else plansPaise += l.totalPaise;
    }

    await DailySummary.findByIdAndUpdate(
      summaryId,
      {
        $setOnInsert: {
          businessId,
          branchId,
          businessDate,
        },
        $inc: {
          'sales.grossPaise': bill.totals.grossPaise,
          'sales.discountPaise': bill.totals.discountPaise,
          'sales.netPaise': bill.totals.taxablePaise,
          'sales.taxPaise': bill.totals.cgstPaise + bill.totals.sgstPaise,
          'sales.servicesPaise': servicesPaise,
          'sales.productsPaise': productsPaise,
          'sales.plansPaise': plansPaise,
          'counts.bills': 1,
          tipsPaise: bill.tips.reduce((s, t) => s + t.amountPaise, 0),
          ...collectionsInc,
        },
      },
      { upsert: true, session }
    );
  }

  /**
   * Approves a held bill ('awaiting_approval' -> 'paid' or 'partly_paid') and applies its effects.
   */
  async approveBill(ctx: RequestContext, billIdStr: string, note?: string): Promise<IBill> {
    if (ctx.role !== 'owner' && ctx.role !== 'manager') {
      throw new AppError(403, 'FORBIDDEN', 'Only manager or owner can approve bills');
    }

    const businessId = toObjectId(ctx.businessId!);
    const billId = toObjectId(billIdStr);

    return withTransaction(async (session) => {
      const bill = await Bill.findOne({ _id: billId, businessId }).session(session);
      if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
      assertBillScope(ctx, bill);

      if (bill.status !== 'awaiting_approval') {
        throw new AppError(422, 'INVALID_TRANSITION', 'Bill is not awaiting approval');
      }

      const customer = await Customer.findOne({ _id: bill.customerId, businessId }).session(session);
      if (!customer) throw new AppError(404, 'NOT_FOUND', 'Customer not found');

      bill.status = bill.totals.duePaise > 0 ? 'partly_paid' : 'paid';
      if (bill.approval) {
        bill.approval.decidedBy = toObjectId(ctx.userId);
        bill.approval.decidedAt = new Date();
      }

      await bill.save({ session });
      await this.applyBillEffects(businessId, bill.branchId, bill, customer, undefined, session, toObjectId(ctx.userId));

      await auditService.logAction({
        ctx,
        action: 'bill.approve',
        entity: 'bill',
        entityId: bill._id,
        branchId: bill.branchId,
        reason: note,
        after: { status: bill.status, approvedBy: ctx.userId },
        session,
      });

      return bill;
    });
  }

  /**
   * Rejects a held bill ('awaiting_approval' -> 'rejected'). Nothing was applied, so nothing is
   * reversed; the invoice number stays used.
   */
  async rejectBill(ctx: RequestContext, billIdStr: string, reason: string): Promise<IBill> {
    if (ctx.role !== 'owner' && ctx.role !== 'manager') {
      throw new AppError(403, 'FORBIDDEN', 'Only manager or owner can reject bills');
    }

    const businessId = toObjectId(ctx.businessId!);
    const bill = await Bill.findOne({ _id: toObjectId(billIdStr), businessId });
    if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
    assertBillScope(ctx, bill);

    if (bill.status !== 'awaiting_approval') {
      throw new AppError(422, 'INVALID_TRANSITION', 'Bill is not awaiting approval');
    }

    bill.status = 'rejected';
    if (bill.approval) {
      bill.approval.decidedBy = toObjectId(ctx.userId);
      bill.approval.decidedAt = new Date();
      bill.approval.rejectReason = reason;
    }
    await bill.save();

    await auditService.logAction({
      ctx,
      action: 'bill.reject',
      entity: 'bill',
      entityId: bill._id,
      branchId: bill.branchId,
      reason,
    });

    return bill;
  }

  /**
   * Undoes everything applyBillEffects did for this bill: package sessions, loyalty, wallet
   * payment, stock, its own dues, old dues it collected, customer stats and the daily summary.
   * Used by cancel (counted as a cancellation) and by edit (before the new version is applied).
   */
  private async reverseBillEffects(
    businessId: Types.ObjectId,
    bill: IBill,
    customer: any,
    session: ClientSession,
    opts: { reason: string; countAsCancel: boolean; actorId: Types.ObjectId }
  ): Promise<void> {
    const branchId = bill.branchId;

    // Plans sold on this bill: unused ones are cancelled; a used one blocks the reversal
    const soldPlans = await CustomerPlan.find({ businessId, soldBillId: bill._id, status: { $ne: 'cancelled' } }).session(session);
    for (const sp of soldPlans) {
      if ((sp.sessions || []).some((x) => x.used > 0) || sp.status === 'used_up' || sp.status === 'transferred') {
        throw new AppError(422, 'PLAN_IN_USE', `${sp.planSnap?.name || 'A plan'} sold on this bill has already been used`);
      }
      sp.status = 'cancelled';
      sp.log.push({ action: 'cancel', at: new Date(), by: opts.actorId, detail: { reason: opts.reason } });
      await sp.save({ session });
    }

    // Wallet credit sold on this bill comes back out (blocked if it has been spent)
    const topupRows = await WalletLedger.find({ businessId, billId: bill._id, type: { $in: ['topup', 'bonus'] } }).session(session);
    const creditPaise = sum(topupRows.map((r) => r.amountPaise));
    if (creditPaise > 0) {
      if (customer.walletBalancePaise < creditPaise) {
        throw new AppError(422, 'PLAN_IN_USE', 'The wallet credit sold on this bill has already been spent');
      }
      customer.walletBalancePaise -= creditPaise;
      await new WalletLedger({
        businessId,
        customerId: customer._id,
        branchId,
        type: 'reverse',
        amountPaise: -creditPaise,
        billId: bill._id,
        reason: opts.reason,
        balanceAfterPaise: customer.walletBalancePaise,
      }).save({ session });
    }

    // Package sessions and vouchers redeemed on this bill are given back
    for (const red of bill.redemptions) {
      if (red.kind === 'package') {
        const line = bill.lines.find((l) => l._id && red.lineId && l._id.equals(red.lineId));
        const plan = line && (await CustomerPlan.findOne({ _id: red.refId, businessId }).session(session));
        const entry = plan?.sessions?.find((x) => x.serviceId.equals(line!.refId));
        if (plan && entry && entry.used > 0) {
          entry.used -= 1;
          if (plan.status === 'used_up') plan.status = 'active';
          await plan.save({ session });
        }
      } else if (red.kind === 'voucher') {
        await CustomerPlan.updateOne({ _id: red.refId, businessId, status: 'used_up' }, { $set: { status: 'active' } }, { session });
      }
    }

    // Loyalty: net of points earned and redeemed on this bill goes back
    const loyaltyRows = await LoyaltyLedger.find({ businessId, billId: bill._id, type: { $in: ['earn', 'redeem', 'reverse'] } }).session(session);
    const netPoints = sum(loyaltyRows.map((r) => r.points));
    if (netPoints !== 0) {
      customer.loyaltyPoints = Math.max(0, customer.loyaltyPoints - netPoints);
      await new LoyaltyLedger({
        businessId,
        customerId: customer._id,
        type: 'reverse',
        points: -netPoints,
        billId: bill._id,
        balanceAfter: customer.loyaltyPoints,
      }).save({ session });
    }

    // Wallet paid on this bill goes back to the wallet
    const walletPaid = sum(bill.payments.filter((p) => p.mode === 'wallet').map((p) => p.amountPaise));
    if (walletPaid > 0) {
      customer.walletBalancePaise += walletPaid;
      await new WalletLedger({
        businessId,
        customerId: customer._id,
        branchId,
        type: 'reverse',
        amountPaise: walletPaid,
        billId: bill._id,
        reason: opts.reason,
        balanceAfterPaise: customer.walletBalancePaise,
      }).save({ session });
    }

    // Stock goes back in, at the cost it went out
    const movements = await StockMovement.find({ businessId, refType: 'bill', refId: bill._id, type: { $in: ['sale', 'service_use'] } }).session(session);
    const reversed = await StockMovement.find({ businessId, refType: 'bill', refId: bill._id, type: 'cancel_reverse' }).session(session);
    // An edited bill may already have been reversed once; only reverse what is still out
    const outstanding = new Map<string, { productId: any; pool: string; qty: number; costPaise: number }>();
    for (const m of [...movements, ...reversed]) {
      const k = `${m.productId}:${m.pool}`;
      const cur = outstanding.get(k) || { productId: m.productId, pool: m.pool, qty: 0, costPaise: 0 };
      cur.qty += m.qty;
      cur.costPaise += m.type === 'cancel_reverse' ? -(m.costPaise || 0) : m.costPaise || 0;
      outstanding.set(k, cur);
    }
    for (const o of outstanding.values()) {
      if (o.qty >= 0) continue;
      await new StockMovement({
        businessId,
        branchId,
        productId: o.productId,
        pool: o.pool,
        type: 'cancel_reverse',
        qty: -o.qty,
        costPaise: Math.max(0, o.costPaise),
        refType: 'bill',
        refId: bill._id,
        businessDate: getBusinessDate(new Date()),
      }).save({ session });
      await StockBalance.findOneAndUpdate(
        { businessId, branchId, productId: o.productId, pool: o.pool },
        { $inc: { qty: -o.qty }, $set: { lastMovementAt: new Date() } },
        { upsert: true, session }
      );
    }

    // This bill's own due: whatever is still outstanding leaves the customer's balance
    const ownDues = await Due.find({ businessId, billId: bill._id, status: { $in: ['open', 'settled'] } }).session(session);
    for (const due of ownDues) {
      customer.duePaise = Math.max(0, customer.duePaise - (due.amountPaise - due.settledPaise));
      due.status = 'void';
      await due.save({ session });
    }

    // Old dues this bill collected are owed again
    const collected = await Due.find({ businessId, 'settlements.billId': bill._id }).session(session);
    for (const due of collected) {
      const amt = sum(due.settlements.filter((st: any) => st.billId?.equals(bill._id)).map((st: any) => st.amountPaise));
      due.settlements = due.settlements.filter((st: any) => !st.billId?.equals(bill._id)) as any;
      due.settledPaise = Math.max(0, due.settledPaise - amt);
      if (due.status === 'settled' && due.settledPaise < due.amountPaise) due.status = 'open';
      await due.save({ session });
      customer.duePaise += amt;
    }

    // Customer visit stats
    customer.stats.visits = Math.max(0, customer.stats.visits - 1);
    customer.stats.spendPaise = Math.max(0, customer.stats.spendPaise - bill.totals.totalPaise);
    await customer.save({ session });

    // Daily summary of the bill's own business day
    const collectionsDec: Record<string, number> = {};
    for (const p of bill.payments) {
      collectionsDec[`collections.${p.mode}`] = (collectionsDec[`collections.${p.mode}`] || 0) - p.amountPaise;
    }
    const byKind = (kinds: string[]) => sum(bill.lines.filter((l) => kinds.includes(l.kind)).map((l) => l.totalPaise));
    await DailySummary.findByIdAndUpdate(
      `${branchId.toString()}:${bill.businessDate}`,
      {
        $inc: {
          'counts.bills': -1,
          ...(opts.countAsCancel ? { 'counts.cancelled': 1 } : {}),
          'sales.grossPaise': -bill.totals.grossPaise,
          'sales.discountPaise': -bill.totals.discountPaise,
          'sales.netPaise': -bill.totals.taxablePaise,
          'sales.taxPaise': -(bill.totals.cgstPaise + bill.totals.sgstPaise),
          'sales.servicesPaise': -byKind(['service']),
          'sales.productsPaise': -byKind(['product']),
          'sales.plansPaise': -byKind(['membership', 'package', 'wallet_topup', 'voucher']),
          tipsPaise: -sum(bill.tips.map((t) => t.amountPaise)),
          ...collectionsDec,
        },
      },
      { session }
    );
  }

  /**
   * Cancels a bill: never deletes it, reverses all of its effects (FR-BIL-14).
   */
  async cancelBill(ctx: RequestContext, billIdStr: string, reason: string): Promise<IBill> {
    if (ctx.role !== 'owner' && ctx.role !== 'manager') {
      throw new AppError(403, 'FORBIDDEN', 'Only manager or owner can cancel bills');
    }

    const businessId = toObjectId(ctx.businessId!);
    const billId = toObjectId(billIdStr);

    return withTransaction(async (session) => {
      const bill = await Bill.findOne({ _id: billId, businessId }).session(session);
      if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
      assertBillScope(ctx, bill);

      if (bill.status === 'cancelled') {
        throw new AppError(422, 'INVALID_TRANSITION', 'Bill is already cancelled');
      }
      if (bill.status === 'rejected') {
        throw new AppError(422, 'INVALID_TRANSITION', 'A rejected bill has nothing to cancel');
      }
      if (bill.status === 'refunded' || bill.status === 'partly_refunded') {
        throw new AppError(422, 'INVALID_TRANSITION', 'A refunded bill cannot be cancelled');
      }
      if (EFFECTIVE_STATUSES.includes(bill.status)) await assertPayrollOpen(bill, session);

      const closure = await DayClosure.findOne({ businessId, branchId: bill.branchId, businessDate: bill.businessDate }).session(session);
      if (closure && closure.status === 'approved' && ctx.role !== 'owner') {
        throw new AppError(409, 'DAY_CLOSED', 'Only business owner can cancel bills on an approved closed day');
      }

      // A bill still awaiting approval never applied anything
      if (EFFECTIVE_STATUSES.includes(bill.status)) {
        const customer = await Customer.findOne({ _id: bill.customerId, businessId }).session(session);
        if (!customer) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
        await this.reverseBillEffects(businessId, bill, customer, session, { reason: `Bill ${bill.invoiceNo} cancelled`, countAsCancel: true, actorId: toObjectId(ctx.userId) });

        if (bill.appointmentId) {
          await Appointment.updateOne(
            { _id: bill.appointmentId, businessId, billId: bill._id },
            {
              $set: { status: 'completed' },
              $unset: { billId: 1 },
              $push: { statusLog: { status: 'completed', at: new Date(), by: toObjectId(ctx.userId), reason: `Bill ${bill.invoiceNo} cancelled` } },
            },
            { session }
          );
        }
      }

      bill.status = 'cancelled';
      bill.cancel = { by: toObjectId(ctx.userId), at: new Date(), reason };
      await bill.save({ session });

      await auditService.logAction({
        ctx,
        action: 'bill.cancel',
        entity: 'bill',
        entityId: bill._id,
        branchId: bill.branchId,
        reason,
        session,
      });

      return bill;
    });
  }

  /**
   * Records a refund on a paid bill (money back; stock and stats are unchanged).
   */
  async refundBill(
    ctx: RequestContext,
    billIdStr: string,
    amountPaise: number,
    mode: string,
    reason: string
  ): Promise<IBill> {
    if (ctx.role !== 'owner' && ctx.role !== 'manager') {
      throw new AppError(403, 'FORBIDDEN', 'Only manager or owner can refund bills');
    }

    const businessId = toObjectId(ctx.businessId!);
    const billId = toObjectId(billIdStr);

    return withTransaction(async (session) => {
      const bill = await Bill.findOne({ _id: billId, businessId }).session(session);
      if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
      assertBillScope(ctx, bill);

      if (!['paid', 'partly_paid', 'partly_refunded'].includes(bill.status)) {
        throw new AppError(422, 'INVALID_TRANSITION', `Cannot refund a bill that is ${bill.status.replace('_', ' ')}`);
      }

      const totalRefunded = (bill.refunds || []).reduce((acc, r) => acc + r.amountPaise, 0);
      if (totalRefunded + amountPaise > bill.totals.paidPaise) {
        throw new AppError(422, 'VALIDATION_ERROR', 'Total refunds cannot exceed total paid amount', {
          details: { refundablePaise: bill.totals.paidPaise - totalRefunded },
        });
      }

      const businessDate = getBusinessDate(new Date());

      bill.refunds.push({
        amountPaise,
        mode,
        reason,
        by: toObjectId(ctx.userId),
        at: new Date(),
        businessDate,
      });

      bill.status = totalRefunded + amountPaise >= bill.totals.paidPaise ? 'refunded' : 'partly_refunded';
      await bill.save({ session });

      // A refund counts against the day it is paid out (which may differ from the bill's day)
      await DailySummary.findByIdAndUpdate(
        `${bill.branchId.toString()}:${businessDate}`,
        {
          $setOnInsert: { businessId, branchId: bill.branchId, businessDate },
          $inc: { refundsPaise: amountPaise },
        },
        { upsert: true, session }
      );

      await auditService.logAction({
        ctx,
        action: 'bill.refund',
        entity: 'bill',
        entityId: bill._id,
        branchId: bill.branchId,
        reason,
        after: { amountPaise, mode, status: bill.status },
        session,
      });

      return bill;
    });
  }

  /**
   * Edits a bill: snapshots the current version, reverses its effects, applies the new version
   * and keeps the invoice number. `reason` and the loaded `__v` are required. Payments that are
   * not sent stay as they were.
   */
  async editBill(ctx: RequestContext, billIdStr: string, updates: any): Promise<IBill> {
    if (ctx.role !== 'owner' && ctx.role !== 'manager') {
      throw new AppError(403, 'FORBIDDEN', 'Only manager or owner can edit bills');
    }

    const businessId = toObjectId(ctx.businessId!);
    const billId = toObjectId(billIdStr);

    return withTransaction(async (session) => {
      const bill = await Bill.findOne({ _id: billId, businessId }).session(session);
      if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
      assertBillScope(ctx, bill);

      if (bill.__v !== updates.__v) {
        throw new AppError(409, 'VERSION_CONFLICT', 'Bill was modified by another user; reload and try again');
      }
      if (!['paid', 'partly_paid', 'awaiting_approval'].includes(bill.status)) {
        throw new AppError(422, 'INVALID_TRANSITION', `A ${bill.status.replace('_', ' ')} bill cannot be edited`);
      }
      await assertPayrollOpen(bill, session);

      const closure = await DayClosure.findOne({ businessId, branchId: bill.branchId, businessDate: bill.businessDate }).session(session);
      if (closure && closure.status === 'approved' && ctx.role !== 'owner') {
        throw new AppError(409, 'DAY_CLOSED', 'Only business owner can edit bills on an approved closed day');
      }

      const business = await Business.findById(businessId).session(session);
      const customer = await Customer.findOne({ _id: bill.customerId, businessId }).session(session);
      if (!business || !customer) throw new AppError(404, 'NOT_FOUND', 'Customer not found');

      const before = bill.toObject();
      await new BillVersion({
        businessId,
        billId: bill._id,
        version: bill.version,
        snapshot: before,
        editedBy: toObjectId(ctx.userId),
        reason: updates.reason,
      }).save({ session });

      const wasEffective = EFFECTIVE_STATUSES.includes(bill.status);
      if (wasEffective) {
        await this.reverseBillEffects(businessId, bill, customer, session, { reason: `Bill ${bill.invoiceNo} edited`, countAsCancel: false, actorId: toObjectId(ctx.userId) });
      }

      const paymentsUntouched = updates.payments === undefined;
      const draft = {
        lines: updates.lines,
        billDiscount: updates.billDiscount === undefined ? bill.billDiscount : updates.billDiscount ?? undefined,
        redemptions: updates.redemptions || [],
        tips: updates.tips ?? bill.tips.map((t) => ({ staffId: t.staffId, amountPaise: t.amountPaise, payout: t.payout })),
        payments: paymentsUntouched ? bill.payments.map((p) => ({ mode: p.mode, amountPaise: p.amountPaise })) : updates.payments,
      };
      const prepared = await this.prepareDraft(ctx, business, bill.branchId, customer, draft, session, { allowOverpay: paymentsUntouched });

      if (prepared.approvalReasons.includes('discount_over_limit') && ctx.role !== 'owner') {
        throw new AppError(422, 'DISCOUNT_LIMIT', 'This discount is above your limit; ask the owner to edit the bill');
      }

      bill.lines = prepared.computed.lines as any;
      bill.billDiscount = draft.billDiscount;
      bill.redemptions = prepared.redemptions as any;
      bill.totals = prepared.computed.totals;
      bill.tips = prepared.tips as any;
      if (!paymentsUntouched) {
        const today = getBusinessDate(new Date());
        bill.payments = updates.payments.map((p: any) => ({
          mode: p.mode,
          amountPaise: p.amountPaise,
          businessDate: today,
          tenderedPaise: p.tenderedPaise,
          ref: p.ref,
          at: new Date(),
        })) as any;
      }
      bill.version += 1;

      if (wasEffective) {
        bill.status = bill.totals.duePaise > 0 ? 'partly_paid' : 'paid';
        await bill.save({ session });
        await this.applyBillEffects(businessId, bill.branchId, bill, customer, undefined, session, toObjectId(ctx.userId));
      } else {
        bill.approval = { reasons: prepared.approvalReasons, requestedAt: new Date() } as any;
        await bill.save({ session });
      }

      await auditService.logAction({
        ctx,
        action: 'bill.edit',
        entity: 'bill',
        entityId: bill._id,
        branchId: bill.branchId,
        reason: updates.reason,
        before: { version: before.version, totals: before.totals, lines: before.lines.map((l: any) => ({ name: l.name, qty: l.qty, totalPaise: l.totalPaise })) },
        after: { version: bill.version, totals: bill.totals, lines: bill.lines.map((l) => ({ name: l.name, qty: l.qty, totalPaise: l.totalPaise })) },
        session,
      });

      return bill;
    });
  }

  /**
   * Collects customer dues outside a new bill using DueReceipt.
   */
  async collectDueReceipt(
    ctx: RequestContext,
    branchIdStr: string,
    customerIdStr: string,
    payments: any[]
  ): Promise<any> {
    const businessId = toObjectId(ctx.businessId!);
    const branchId = toObjectId(branchIdStr);
    const customerId = toObjectId(customerIdStr);

    return withTransaction(async (session) => {
      const branch = await Branch.findOne({ _id: branchId, businessId }).session(session);
      if (!branch) throw new AppError(404, 'NOT_FOUND', 'Branch not found');

      const customer = await Customer.findOne({ _id: customerId, businessId }).session(session);
      if (!customer) throw new AppError(404, 'NOT_FOUND', 'Customer not found');

      if (payments.some((p) => p.mode === 'wallet')) {
        throw new AppError(422, 'VALIDATION_ERROR', 'Dues are collected in cash, UPI or card');
      }
      const totalPaid = payments.reduce((acc, p) => acc + p.amountPaise, 0);
      let remainingToAllocate = totalPaid;

      // Find open dues, oldest first; the receipt may not be larger than what is owed
      const openDues = await Due.find({ businessId, customerId, status: 'open' }).sort({ createdAt: 1 }).session(session);
      const outstandingPaise = sum(openDues.map((d) => d.amountPaise - d.settledPaise));
      if (totalPaid > outstandingPaise) {
        throw new AppError(422, 'VALIDATION_ERROR', 'Payment is more than the customer owes', {
          details: { outstandingPaise, paidPaise: totalPaid },
        });
      }
      const allocations: any[] = [];

      for (const due of openDues) {
        if (remainingToAllocate <= 0) break;
        const dueOutstanding = due.amountPaise - due.settledPaise;
        const settleAmt = Math.min(remainingToAllocate, dueOutstanding);

        due.settledPaise += settleAmt;
        if (due.settledPaise >= due.amountPaise) {
          due.status = 'settled';
        }
        allocations.push({ dueId: due._id, amountPaise: settleAmt });
        remainingToAllocate -= settleAmt;
        await due.save({ session });
      }

      customer.duePaise = Math.max(0, customer.duePaise - (totalPaid - remainingToAllocate));
      await customer.save({ session });

      const businessDate = getBusinessDate(new Date());
      const business = await Business.findById(businessId).session(session);
      const fy = getFinancialYear(new Date(), business?.fyStartMonth || 4);
      const receiptNo = await this.getNextReceiptNumber(businessId, branchId, branch.invoicePrefix, fy, session);

      const dueReceipt = new DueReceipt({
        businessId,
        branchId,
        customerId,
        receiptNo,
        businessDate,
        payments,
        allocations,
        status: 'active',
      });
      await dueReceipt.save({ session });

      // Collected money belongs to today's takings at this branch (day-end cash)
      const collectionsInc: Record<string, number> = {};
      for (const p of payments) {
        collectionsInc[`collections.${p.mode}`] = (collectionsInc[`collections.${p.mode}`] || 0) + p.amountPaise;
      }
      await DailySummary.findByIdAndUpdate(
        `${branchId.toString()}:${businessDate}`,
        { $setOnInsert: { businessId, branchId, businessDate }, $inc: collectionsInc },
        { upsert: true, session }
      );

      await auditService.logAction({
        ctx,
        action: 'due_receipt.create',
        entity: 'dueReceipt',
        entityId: dueReceipt._id,
        branchId,
        after: { receiptNo, totalPaid },
        session,
      });

      return dueReceipt;
    });
  }

  async getBills(ctx: RequestContext, branchIdStr: string, filters: any): Promise<{ bills: IBill[]; total: number }> {
    const businessId = toObjectId(ctx.businessId!);
    const branchId = toObjectId(branchIdStr);

    const query: any = { businessId, branchId };
    if (filters.from || filters.to) {
      query.businessDate = {};
      if (filters.from) query.businessDate.$gte = filters.from;
      if (filters.to) query.businessDate.$lte = filters.to;
    }
    if (filters.status) query.status = filters.status;
    if (filters.billedBy) query.billedByName = filters.billedBy;
    if (filters.customerId) query.customerId = toObjectId(filters.customerId);
    if (filters.q) query.invoiceNo = { $regex: filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

    const page = Math.max(1, filters.page || 1);
    const limit = Math.min(100, Math.max(1, filters.limit || 25));
    const skip = (page - 1) * limit;

    const [bills, total] = await Promise.all([
      Bill.find(query).sort({ businessDate: -1, createdAt: -1 }).skip(skip).limit(limit),
      Bill.countDocuments(query),
    ]);

    return { bills, total };
  }

  async getBillById(ctx: RequestContext, id: string): Promise<any> {
    const businessId = toObjectId(ctx.businessId!);
    const bill = await Bill.findOne({ _id: toObjectId(id), businessId });
    if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
    assertBillScope(ctx, bill);

    const versions = await BillVersion.find({ businessId, billId: bill._id }).sort({ version: -1 });
    return { bill, versions };
  }

  /**
   * The invoice as a PDF (A4 or 80 mm thermal), with the same branch scoping as GET /bills/:id.
   */
  async getInvoicePdf(ctx: RequestContext, id: string, format: 'a4' | 'thermal'): Promise<{ invoiceNo: string; pdf: Buffer }> {
    const { bill } = await this.getBillById(ctx, id);
    const [business, branch] = await Promise.all([
      Business.findById(bill.businessId).select('name gst address'),
      Branch.findOne({ _id: bill.branchId, businessId: bill.businessId }).select('name address phone'),
    ]);
    const pdf = await pdfService.generateInvoicePdf(bill.toObject(), business?.toObject(), branch?.toObject(), format);
    return { invoiceNo: bill.invoiceNo, pdf };
  }

  /**
   * Bills waiting for approval. Managers only see their branches (a branchId outside them is empty).
   */
  async getApprovals(ctx: RequestContext, branchIdStr?: string): Promise<IBill[]> {
    const businessId = toObjectId(ctx.businessId!);
    const query: any = { businessId, status: 'awaiting_approval' };

    if (ctx.role === 'manager') {
      const allowed = branchIdStr ? ctx.branchIds.filter((b) => b === branchIdStr) : ctx.branchIds;
      query.branchId = { $in: allowed.map(toObjectId) };
    } else if (branchIdStr) {
      query.branchId = toObjectId(branchIdStr);
    }

    return Bill.find(query).sort({ createdAt: 1 });
  }

  async getCustomerDues(ctx: RequestContext, customerId: string): Promise<any[]> {
    const businessId = toObjectId(ctx.businessId!);
    if (!(await Customer.exists({ _id: toObjectId(customerId), businessId }))) {
      throw new AppError(404, 'NOT_FOUND', 'Customer not found');
    }
    return Due.find({ businessId, customerId: toObjectId(customerId), status: 'open' })
      .sort({ createdAt: 1 })
      .populate('billId', 'invoiceNo businessDate branchId');
  }
}

export const billingService = new BillingService();
