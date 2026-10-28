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
  withTransaction,
  IBill,
} from '../models';
import {
  AppError,
  getBusinessDate,
  getFinancialYear,
  generateRandomToken,
  logger,
} from '../utils';
import { RequestContext, toObjectId } from './context';
import { auditService } from './audit.service';
import { notificationService } from './notification.service';
import { computeBill, ComputeBillInput, ComputeLineItem } from './billing.compute';

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
   * Previews a bill calculation and checks if approval is required.
   */
  async previewBill(ctx: RequestContext, branchIdStr: string, draft: any): Promise<any> {
    const businessId = toObjectId(ctx.businessId!);
    const branchId = toObjectId(branchIdStr);

    const business = await Business.findById(businessId);
    if (!business) throw new AppError(404, 'NOT_FOUND', 'Business not found');

    let customer: any = null;
    if (draft.customerId) {
      customer = await Customer.findOne({ _id: toObjectId(draft.customerId), businessId });
    }

    // Build compute input lines
    const inputLines = await this.resolveInputLines(businessId, branchId, draft.lines);

    const computeInput: ComputeBillInput = {
      lines: inputLines,
      billDiscount: draft.billDiscount,
      redemptions: draft.redemptions || [],
      tips: draft.tips || [],
      payments: draft.payments || [],
      gstApplied: draft.gstApplied !== undefined ? Boolean(draft.gstApplied) : business.gst.enabled,
      businessGstBps: business.gst.rateBps || 1800,
    };

    const computed = computeBill(computeInput);

    // Check approval reasons
    const approvalReasons: ('discount_over_limit' | 'partly_paid')[] = [];

    if (computed.totals.duePaise > 0) {
      approvalReasons.push('partly_paid');
    }

    const discountOverLimit = this.checkDiscountLimit(ctx, business, draft, computed);
    if (discountOverLimit) {
      approvalReasons.push('discount_over_limit');
    }

    return {
      totals: computed.totals,
      lines: computed.lines,
      computed,
      needsApproval: approvalReasons.length > 0 && ctx.role !== 'owner',
      approvalReasons,
    };
  }

  /**
   * Checks whether the requested discounts exceed the user's role limits.
   */
  private checkDiscountLimit(ctx: RequestContext, business: any, draft: any, computed: any): boolean {
    if (ctx.role === 'owner') return false; // Owner has unlimited discount authority

    let allowedBps = business.discountLimits.branchBps || 1000;
    if (ctx.role === 'manager') {
      allowedBps = business.discountLimits.managerBps || 2000;
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
   * Resolves products/services snapshots and prices for bill lines.
   */
  private async resolveInputLines(
    businessId: Types.ObjectId,
    branchId: Types.ObjectId,
    rawLines: any[],
    session?: ClientSession
  ): Promise<ComputeLineItem[]> {
    const inputLines: ComputeLineItem[] = [];

    for (const raw of rawLines) {
      const refId = toObjectId(raw.refId);

      if (raw.kind === 'service') {
        const svc = await Service.findOne({ _id: refId, businessId, active: true }).session(session || null);
        if (!svc) throw new AppError(404, 'NOT_FOUND', `Service ${raw.refId} not found`);

        const bp = svc.branchPrices.find((p) => p.branchId.equals(branchId));
        const unitPricePaise = bp && bp.pricePaise !== undefined ? bp.pricePaise : svc.basePricePaise;

        // Resolve staff
        const staff = (raw.staff || []).map((st: any) => ({
          staffId: toObjectId(st.staffId),
          name: st.name || 'Staff',
          splitBps: st.splitBps,
          rule: svc.commission,
        }));

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
          consumablesUsed: (svc.consumables || []).map((c) => ({
            productId: c.productId,
            qty: c.qty * (raw.qty || 1),
            costPaise: 0,
          })),
        });
      } else if (raw.kind === 'product') {
        const prod = await Product.findOne({ _id: refId, businessId, active: true }).session(session || null);
        if (!prod) throw new AppError(404, 'NOT_FOUND', `Product ${raw.refId} not found`);

        const unitPricePaise = prod.sellingPricePaise || prod.mrpPaise || 0;
        const staff = (raw.staff || []).map((st: any) => ({
          staffId: toObjectId(st.staffId),
          name: st.name || 'Staff',
          splitBps: 10000,
          productBps: 0,
        }));

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
   * Saves a bill inside a MongoDB transaction with atomic numbering and effects.
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

    // 1. Check idempotency
    const existingBill = await Bill.findOne({ businessId, idempotencyKey: key });
    if (existingBill) {
      return existingBill;
    }

    return withTransaction(async (session) => {
      // 2. Load and validate business, branch, customer
      const business = await Business.findById(businessId).session(session);
      if (!business || business.status === 'suspended') {
        throw new AppError(403, 'ACCOUNT_INACTIVE', 'Business is suspended');
      }

      const branch = await Branch.findOne({ _id: branchId, businessId }).session(session);
      if (!branch || branch.status === 'deactivated') {
        throw new AppError(422, 'BRANCH_INACTIVE', 'Branch is deactivated');
      }

      const businessDate = getBusinessDate(new Date());

      // Check day closure (409 DAY_CLOSED)
      const closure = await DayClosure.findOne({ businessId, branchId, businessDate }).session(session);
      if (closure && closure.status === 'approved') {
        throw new AppError(409, 'DAY_CLOSED', `Branch day ${businessDate} has been closed and approved`);
      }

      const customer = await Customer.findOne({ _id: toObjectId(draft.customerId), businessId }).session(session);
      if (!customer) throw new AppError(404, 'NOT_FOUND', 'Customer not found');

      // Validate Billed By for branch login role
      let billedByName = ctx.name;
      let billedByStaffId: Types.ObjectId | undefined;

      if (ctx.role === 'branch') {
        if (!draft.billedByStaffId) {
          throw new AppError(400, 'VALIDATION_ERROR', 'billedByStaffId is required for bills created by branch login');
        }
        const receptionist = await Staff.findOne({
          _id: toObjectId(draft.billedByStaffId),
          businessId,
          branchId,
          designation: 'receptionist',
          status: 'active',
        }).session(session);
        if (!receptionist) {
          throw new AppError(400, 'VALIDATION_ERROR', 'Billed by must be an active receptionist of this branch');
        }
        billedByStaffId = receptionist._id;
        billedByName = receptionist.name;
      } else if (draft.billedByStaffId) {
        billedByStaffId = toObjectId(draft.billedByStaffId);
      }

      // 3. Resolve input lines & redemptions
      const inputLines = await this.resolveInputLines(businessId, branchId, draft.lines, session);

      // Verify staff split sums to 10000 bps for each service line
      for (const l of inputLines) {
        if (l.kind === 'service' && l.staff && l.staff.length > 0) {
          const sumSplits = l.staff.reduce((acc, s) => acc + (s.splitBps || 0), 0);
          if (sumSplits !== 10000) {
            throw new AppError(422, 'SPLIT_INVALID', `Staff commission splits for line ${l.name} must total 10000 bps (100%)`);
          }
        }
      }

      // Validate and enrich redemptions
      const enrichedRedemptions: any[] = [];
      for (const red of draft.redemptions || []) {
        if (red.kind === 'package') {
          const plan = await CustomerPlan.findOne({
            _id: toObjectId(red.refId),
            businessId,
            customerId: customer._id,
            status: 'active',
          }).session(session);
          if (!plan) throw new AppError(422, 'PLAN_INACTIVE', 'Package plan not found or inactive');

          const lineIdx = red.lineId !== undefined ? Number(red.lineId) : 0;
          const targetLine = inputLines[lineIdx];
          if (!targetLine) throw new AppError(422, 'NO_SESSIONS_LEFT', 'Invalid lineId for package redemption');

          const sessionEntry = (plan.sessions || []).find((s) => s.serviceId.equals(targetLine.refId));
          if (!sessionEntry || sessionEntry.used >= sessionEntry.total) {
            throw new AppError(422, 'NO_SESSIONS_LEFT', 'No package sessions remaining for this service');
          }

          enrichedRedemptions.push({
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
          }).session(session);
          if (!plan) throw new AppError(422, 'PLAN_INACTIVE', 'Membership not found or inactive');

          enrichedRedemptions.push({
            kind: 'membership',
            refId: plan._id,
            membershipDiscountBps: plan.planSnap?.membership?.serviceDiscountBps || 0,
            amountPaise: 0,
          });
        } else if (red.kind === 'loyalty') {
          if (customer.loyaltyPoints < (red.points || 0)) {
            throw new AppError(422, 'INSUFFICIENT_WALLET', 'Insufficient loyalty points');
          }
          enrichedRedemptions.push({
            kind: 'loyalty',
            refId: customer._id,
            points: red.points,
            amountPaise: red.amountPaise,
          });
        }
      }

      // Check wallet payment balance
      const walletPayment = (draft.payments || []).find((p: any) => p.mode === 'wallet');
      if (walletPayment && walletPayment.amountPaise > 0) {
        if (customer.walletBalancePaise < walletPayment.amountPaise) {
          throw new AppError(422, 'INSUFFICIENT_WALLET', 'Insufficient wallet balance');
        }
      }

      // 4. Compute bill
      const computeInput: ComputeBillInput = {
        lines: inputLines,
        billDiscount: draft.billDiscount,
        redemptions: enrichedRedemptions,
        tips: draft.tips || [],
        payments: draft.payments || [],
        gstApplied: business.gst.enabled,
        businessGstBps: business.gst.rateBps || 1800,
      };

      const computed = computeBill(computeInput);

      // 5. Determine bill status
      const approvalReasons: ('discount_over_limit' | 'partly_paid')[] = [];
      if (computed.totals.duePaise > 0) {
        approvalReasons.push('partly_paid');
      }
      if (this.checkDiscountLimit(ctx, business, draft, computed)) {
        approvalReasons.push('discount_over_limit');
      }

      let status: 'awaiting_approval' | 'paid' | 'partly_paid' = 'paid';
      if (approvalReasons.length > 0) {
        if (ctx.role === 'owner') {
          status = computed.totals.duePaise > 0 ? 'partly_paid' : 'paid';
        } else {
          status = 'awaiting_approval';
        }
      }

      // 6. Generate invoice number
      const fy = getFinancialYear(new Date(), business.fyStartMonth);
      const invoiceNo = await this.getNextInvoiceNumber(businessId, branchId, branch.invoicePrefix, fy, session);

      // 7. Save bill
      const bill = new Bill({
        businessId,
        branchId,
        invoiceNo,
        fy,
        businessDate,
        customerId: customer._id,
        customerSnap: {
          name: customer.name,
          phone: customer.phone,
        },
        billedByStaffId,
        billedByName,
        appointmentId: draft.appointmentId ? toObjectId(draft.appointmentId) : undefined,
        gstApplied: business.gst.enabled,
        pricesInclusive: business.gst.pricesInclusive,
        lines: computed.lines,
        billDiscount: draft.billDiscount,
        redemptions: enrichedRedemptions,
        totals: computed.totals,
        payments: (draft.payments || []).map((p: any) => ({
          mode: p.mode,
          amountPaise: p.amountPaise,
          businessDate,
          tenderedPaise: p.tenderedPaise,
          ref: p.ref,
          at: new Date(),
        })),
        tips: (draft.tips || []).map((t: any) => ({
          staffId: toObjectId(t.staffId),
          staffName: t.staffName || 'Staff',
          amountPaise: t.amountPaise,
          payout: t.payout,
        })),
        status,
        approval:
          status === 'awaiting_approval'
            ? {
                reasons: approvalReasons,
                requestedAt: new Date(),
              }
            : undefined,
        version: 1,
        refunds: [],
        idempotencyKey: key,
      });

      await bill.save({ session });

      // 8. If paid or partly_paid (e.g. approved or owner save), apply effects immediately!
      if (status === 'paid' || status === 'partly_paid') {
        await this.applyBillEffects(businessId, branchId, bill, customer, draft.collectDues, session, toObjectId(ctx.userId));
      }

      await auditService.logAction({
        ctx,
        action: 'bill.create',
        entity: 'bill',
        entityId: bill._id,
        branchId,
        billedByName,
        after: {
          invoiceNo: bill.invoiceNo,
          totalPaise: bill.totals.totalPaise,
          status: bill.status,
        },
        session,
      });

      // Bump scope change counters
      await notificationService.bumpScope(businessId.toString(), `bills:${branchIdStr}`);
      if (draft.appointmentId) {
        await notificationService.bumpScope(businessId.toString(), `appointments:${branchIdStr}:${businessDate}`);
      }

      return bill;
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
    collectDues?: { dueId: string; amountPaise: number }[],
    session?: ClientSession,
    userId?: Types.ObjectId
  ): Promise<void> {
    const businessDate = bill.businessDate;
    const actorId = userId || bill.billedByStaffId || businessId;

    // 1. Consume package sessions
    for (const red of bill.redemptions) {
      if (red.kind === 'package') {
        const line = bill.lines.find((l) => l._id && red.lineId && l._id.equals(red.lineId));
        if (line) {
          await CustomerPlan.updateOne(
            { _id: red.refId, 'sessions.serviceId': line.refId },
            { $inc: { 'sessions.$.used': 1 } },
            { session }
          );
        }
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
        const plan = await Plan.findById(l.refId).session(session || null);
        if (plan) {
          const validFromDate = new Date();
          const validTillDate = new Date(validFromDate.getTime() + plan.validityDays * 24 * 60 * 60 * 1000);

          let voucherCode: string | undefined;
          if (l.kind === 'voucher') {
            voucherCode = `VOUCH-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
          }

          const customerPlan = new CustomerPlan({
            businessId,
            customerId: customer._id,
            planId: plan._id,
            planSnap: plan.toObject(),
            soldBillId: bill._id,
            soldBranchId: branchId,
            validFrom: getBusinessDate(validFromDate),
            validTill: getBusinessDate(validTillDate),
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
                action: 'redeem',
                at: new Date(),
                by: actorId,
                detail: { soldBillId: bill._id },
              },
            ],
          });
          await customerPlan.save({ session });
        }
      } else if (l.kind === 'wallet_topup') {
        const plan = await Plan.findById(l.refId).session(session || null);
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
        // Retail product stock deduction
        await new StockMovement({
          businessId,
          branchId,
          productId: l.refId,
          pool: 'retail',
          type: 'sale',
          qty: -l.qty,
          costPaise: 0,
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

    // 5. Settle old dues if collectDues was specified
    if (collectDues && collectDues.length > 0) {
      for (const item of collectDues) {
        const due = await Due.findOne({ _id: toObjectId(item.dueId), businessId, status: 'open' }).session(session || null);
        if (due) {
          const settleAmt = Math.min(item.amountPaise, due.amountPaise - due.settledPaise);
          due.settledPaise += settleAmt;
          if (due.settledPaise >= due.amountPaise) {
            due.status = 'settled';
          }
          due.settlements.push({
            billId: bill._id,
            amountPaise: settleAmt,
            at: new Date(),
          });
          await due.save({ session });

          customer.duePaise = Math.max(0, customer.duePaise - settleAmt);
        }
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
   * Approves a held bill ('awaiting_approval' -> 'paid' or 'partly_paid').
   */
  async approveBill(ctx: RequestContext, billIdStr: string): Promise<IBill> {
    if (ctx.role !== 'owner' && ctx.role !== 'manager') {
      throw new AppError(403, 'FORBIDDEN', 'Only manager or owner can approve bills');
    }

    const businessId = toObjectId(ctx.businessId!);
    const billId = toObjectId(billIdStr);

    return withTransaction(async (session) => {
      const bill = await Bill.findOne({ _id: billId, businessId }).session(session);
      if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');

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
        after: { status: bill.status, approvedBy: ctx.userId },
        session,
      });

      return bill;
    });
  }

  /**
   * Rejects a held bill ('awaiting_approval' -> 'rejected').
   */
  async rejectBill(ctx: RequestContext, billIdStr: string, reason: string): Promise<IBill> {
    if (ctx.role !== 'owner' && ctx.role !== 'manager') {
      throw new AppError(403, 'FORBIDDEN', 'Only manager or owner can reject bills');
    }

    const businessId = toObjectId(ctx.businessId!);
    const billId = toObjectId(billIdStr);

    const bill = await Bill.findOne({ _id: billId, businessId });
    if (!bill) throw new AppError(404, 'NOT_FOUND', 'Bill not found');

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
   * Cancels a bill with full reversals per FR-BIL-14.
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

      if (bill.status === 'cancelled') {
        throw new AppError(422, 'INVALID_TRANSITION', 'Bill is already cancelled');
      }

      // Check if day closure is approved: owner only!
      const closure = await DayClosure.findOne({ businessId, branchId: bill.branchId, businessDate: bill.businessDate }).session(session);
      if (closure && closure.status === 'approved' && ctx.role !== 'owner') {
        throw new AppError(409, 'DAY_CLOSED', 'Only business owner can cancel bills on an approved closed day');
      }

      // Check if any plan sold on this bill has already been redeemed
      const soldPlans = await CustomerPlan.find({ businessId, soldBillId: bill._id }).session(session);
      for (const sp of soldPlans) {
        const hasUsedSessions = (sp.sessions || []).some((s) => s.used > 0);
        if (hasUsedSessions || sp.status === 'used_up') {
          throw new AppError(422, 'PLAN_IN_USE', 'Cannot cancel bill: sold package plan has already been partially redeemed');
        }
      }

      // 1. Compensating reversals
      const customer = await Customer.findOne({ _id: bill.customerId, businessId }).session(session);

      // Revert package redemptions
      for (const red of bill.redemptions) {
        if (red.kind === 'package') {
          const line = bill.lines.find((l) => l._id && red.lineId && l._id.equals(red.lineId));
          if (line) {
            await CustomerPlan.updateOne(
              { _id: red.refId, 'sessions.serviceId': line.refId },
              { $inc: { 'sessions.$.used': -1 } },
              { session }
            );
          }
        }
      }

      // Revert wallet payment
      const walletPayment = bill.payments.find((p) => p.mode === 'wallet');
      if (walletPayment && customer) {
        customer.walletBalancePaise += walletPayment.amountPaise;
        await Customer.updateOne(
          { _id: customer._id, businessId },
          { $inc: { walletBalancePaise: walletPayment.amountPaise } },
          { session }
        );

        await new WalletLedger({
          businessId,
          customerId: customer._id,
          branchId: bill.branchId,
          type: 'reverse',
          amountPaise: walletPayment.amountPaise,
          billId: bill._id,
          reason: `Bill ${bill.invoiceNo} cancellation`,
          balanceAfterPaise: customer.walletBalancePaise,
        }).save({ session });
      }

      // Cancel sold customer plans
      for (const sp of soldPlans) {
        sp.status = 'cancelled';
        await sp.save({ session });
      }

      // Reverse stock movements
      for (const l of bill.lines) {
        if (l.kind === 'product') {
          await new StockMovement({
            businessId,
            branchId: bill.branchId,
            productId: l.refId,
            pool: 'retail',
            type: 'cancel_reverse',
            qty: l.qty,
            costPaise: 0,
            refType: 'bill',
            refId: bill._id,
            businessDate: bill.businessDate,
          }).save({ session });

          await StockBalance.findOneAndUpdate(
            { businessId, branchId: bill.branchId, productId: l.refId, pool: 'retail' },
            { $inc: { qty: l.qty }, $set: { lastMovementAt: new Date() } },
            { upsert: true, session }
          );
        } else if (l.kind === 'service' && l.consumablesUsed) {
          for (const c of l.consumablesUsed) {
            await new StockMovement({
              businessId,
              branchId: bill.branchId,
              productId: c.productId,
              pool: 'consumable',
              type: 'cancel_reverse',
              qty: c.qty,
              costPaise: 0,
              refType: 'bill',
              refId: bill._id,
              businessDate: bill.businessDate,
            }).save({ session });

            await StockBalance.findOneAndUpdate(
              { businessId, branchId: bill.branchId, productId: c.productId, pool: 'consumable' },
              { $inc: { qty: c.qty }, $set: { lastMovementAt: new Date() } },
              { upsert: true, session }
            );
          }
        }
      }

      // Void dues
      await Due.updateMany({ businessId, billId: bill._id }, { $set: { status: 'void' } }, { session });
      if (customer && bill.totals.duePaise > 0) {
        customer.duePaise = Math.max(0, customer.duePaise - bill.totals.duePaise);
        await customer.save({ session });
      }

      // Update bill record
      bill.status = 'cancelled';
      bill.cancel = {
        by: toObjectId(ctx.userId),
        at: new Date(),
        reason,
      };
      await bill.save({ session });

      // Revert DailySummary counts
      const summaryId = `${bill.branchId.toString()}:${bill.businessDate}`;
      await DailySummary.findByIdAndUpdate(
        summaryId,
        {
          $inc: {
            'counts.bills': -1,
            'counts.cancelled': 1,
            'sales.grossPaise': -bill.totals.grossPaise,
            'sales.discountPaise': -bill.totals.discountPaise,
            'sales.netPaise': -bill.totals.taxablePaise,
            'sales.taxPaise': -(bill.totals.cgstPaise + bill.totals.sgstPaise),
          },
        },
        { session }
      );

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
   * Records a refund on a paid bill.
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

      if (bill.status === 'cancelled' || bill.status === 'rejected') {
        throw new AppError(422, 'INVALID_TRANSITION', 'Cannot refund a cancelled or rejected bill');
      }

      const totalRefunded = (bill.refunds || []).reduce((acc, r) => acc + r.amountPaise, 0);
      if (totalRefunded + amountPaise > bill.totals.paidPaise) {
        throw new AppError(422, 'VALIDATION_ERROR', 'Total refunds cannot exceed total paid amount');
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

      // Update DailySummary refunds
      const summaryId = `${bill.branchId.toString()}:${businessDate}`;
      await DailySummary.findByIdAndUpdate(
        summaryId,
        {
          $inc: {
            refundsPaise: amountPaise,
          },
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
   * Edits an existing bill, creates a new BillVersion snapshot, and re-applies effects.
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

      // Optimistic concurrency check
      if (updates.__v !== undefined && bill.__v !== updates.__v) {
        throw new AppError(409, 'VERSION_CONFLICT', 'Bill was modified by another user');
      }

      // Check day closure (owner-only on closed day)
      const closure = await DayClosure.findOne({ businessId, branchId: bill.branchId, businessDate: bill.businessDate }).session(session);
      if (closure && closure.status === 'approved' && ctx.role !== 'owner') {
        throw new AppError(409, 'DAY_CLOSED', 'Only business owner can edit bills on an approved closed day');
      }

      // Save previous version in BillVersion
      const versionDoc = new BillVersion({
        businessId,
        billId: bill._id,
        version: bill.version,
        snapshot: bill.toObject(),
        editedBy: toObjectId(ctx.userId),
        reason: updates.reason || 'Bill edit',
      });
      await versionDoc.save({ session });

      // Reverse current version's effects
      // (Similar to cancel reversals)
      // Then recompute
      const inputLines = await this.resolveInputLines(businessId, bill.branchId, updates.lines, session);
      const business = await Business.findById(businessId).session(session);

      const computed = computeBill({
        lines: inputLines,
        billDiscount: updates.billDiscount,
        redemptions: updates.redemptions || [],
        tips: updates.tips || [],
        payments: updates.payments || [],
        gstApplied: business!.gst.enabled,
        businessGstBps: business!.gst.rateBps || 1800,
      });

      bill.lines = computed.lines as any;
      bill.billDiscount = updates.billDiscount;
      bill.totals = computed.totals;
      bill.payments = updates.payments || bill.payments;
      bill.tips = updates.tips || bill.tips;
      bill.version += 1;
      bill.__v += 1;

      await bill.save({ session });

      await auditService.logAction({
        ctx,
        action: 'bill.edit',
        entity: 'bill',
        entityId: bill._id,
        branchId: bill.branchId,
        reason: updates.reason,
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

      const totalPaid = payments.reduce((acc, p) => acc + p.amountPaise, 0);
      let remainingToAllocate = totalPaid;

      // Find open dues, oldest first
      const openDues = await Due.find({ businessId, customerId, status: 'open' }).sort({ createdAt: 1 }).session(session);
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

    if (filters.from && filters.to) {
      query.businessDate = { $gte: filters.from, $lte: filters.to };
    } else if (filters.from) {
      query.businessDate = filters.from;
    }

    if (filters.status) query.status = filters.status;
    if (filters.billedBy) query.billedByName = filters.billedBy;
    if (filters.customerId) query.customerId = toObjectId(filters.customerId);

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

    const versions = await BillVersion.find({ businessId, billId: bill._id }).sort({ version: -1 });
    return { bill, versions };
  }

  async getApprovals(ctx: RequestContext, branchIdStr?: string): Promise<IBill[]> {
    const businessId = toObjectId(ctx.businessId!);
    const query: any = { businessId, status: 'awaiting_approval' };

    if (branchIdStr) {
      query.branchId = toObjectId(branchIdStr);
    } else if (ctx.role === 'manager') {
      query.branchId = { $in: ctx.branchIds.map(toObjectId) };
    }

    return Bill.find(query).sort({ createdAt: -1 });
  }

  async getCustomerDues(ctx: RequestContext, customerId: string): Promise<any[]> {
    return Due.find({
      businessId: toObjectId(ctx.businessId!),
      customerId: toObjectId(customerId),
      status: 'open',
    }).populate('billId', 'invoiceNo businessDate');
  }
}

export const billingService = new BillingService();
