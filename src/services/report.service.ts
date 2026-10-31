import { Types } from 'mongoose';
import {
  Bill,
  Appointment,
  Branch,
  Business,
  Customer,
  CustomerPlan,
  DueReceipt,
  Due,
  StockBalance,
  StockMovement,
  Product,
  Staff,
  Attendance,
  Expense,
  PayrollRun,
  DayClosure,
  Lead,
  Campaign,
  WaConversation,
} from '../models';
import { AppError, ErrorCode, getBusinessDate, addDays } from '../utils';
import { RequestContext, toObjectId } from './context';
import ExcelJS from 'exceljs';

/*
 * Reports are computed from the source records (bills, receipts, ledgers, stock, attendance), so
 * they always agree with what the screens show. Sales are counted on the bill's business date;
 * refunds on the day they were paid out. "Effective" bills are the ones whose sale happened.
 */

const EFFECTIVE = ['paid', 'partly_paid', 'partly_refunded', 'refunded'];
const MAX_RANGE_DAYS = 366;

export const REPORT_NAMES = [
  'sales-summary',
  'branch-comparison',
  'service-profitability',
  'product-profitability',
  'customer-retention',
  'membership-liability',
  'staff-performance',
  'attendance-payroll',
  'inventory-valuation',
  'discounts-cancellations',
  'expenses-pnl',
  'day-closures',
  'gstr-1',
  'leads-conversion',
  'whatsapp-spend',
] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

export interface ReportParams {
  branchId?: string;
  from?: string;
  to?: string;
}

interface Scope {
  businessId: Types.ObjectId;
  branchIds: Types.ObjectId[] | null; // null = every branch of the business
  from: string;
  to: string;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const inRange = (d: string | undefined, s: Scope) => !!d && d >= s.from && d <= s.to;

/**
 * Which branches a report or the dashboard may cover. Owners: any branch of the business (one, or
 * all). Managers and branch logins: their own branches only (another branch is 403).
 */
async function resolveScope(ctx: RequestContext, params: ReportParams): Promise<Scope> {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const today = getBusinessDate();
  const from = params.from || params.to || today;
  const to = params.to || (params.from ? today : today);
  if (to < from) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'to must be on or after from', { fields: { to: 'Before from' } });
  }
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_RANGE_DAYS) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, `A report covers at most ${MAX_RANGE_DAYS} days`, { fields: { to: 'Range too long' } });
  }

  let branchIds: Types.ObjectId[] | null = null;
  if (params.branchId) {
    if (ctx.role !== 'owner' && !ctx.branchIds.includes(params.branchId)) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'You do not have access to this branch');
    }
    if (!(await Branch.exists({ _id: toObjectId(params.branchId), businessId }))) {
      throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Branch not found');
    }
    branchIds = [toObjectId(params.branchId)];
  } else if (ctx.role !== 'owner') {
    branchIds = ctx.branchIds.map(toObjectId);
  }
  return { businessId, branchIds, from, to };
}

const branchMatch = (s: Scope, field = 'branchId') => (s.branchIds ? { [field]: { $in: s.branchIds } } : {});

async function branchNames(s: Scope): Promise<Map<string, { name: string; code: string }>> {
  const branches = await Branch.find({ businessId: s.businessId, ...(s.branchIds ? { _id: { $in: s.branchIds } } : {}) }).select('name code');
  return new Map(branches.map((b) => [b._id.toString(), { name: b.name, code: b.code }]));
}

/** Effective bills dated in the range (plus, optionally, any bill with a refund paid in the range). */
async function billsInRange(s: Scope, opts: { withRefundsInRange?: boolean } = {}) {
  const dated = { businessId: s.businessId, ...branchMatch(s), businessDate: { $gte: s.from, $lte: s.to } };
  const query = opts.withRefundsInRange
    ? { businessId: s.businessId, ...branchMatch(s), $or: [dated, { 'refunds.businessDate': { $gte: s.from, $lte: s.to } }] }
    : { ...dated, status: { $in: EFFECTIVE } };
  return Bill.find(query).lean();
}

const lineKindNet = (bill: any, kinds: string[]) => sum(bill.lines.filter((l: any) => kinds.includes(l.kind)).map((l: any) => l.taxablePaise));
const PLAN_KINDS = ['membership', 'package', 'wallet_topup', 'voucher'];

// ----------------------------------------------------
// Dashboard
// ----------------------------------------------------

export async function getDashboardKPIs(ctx: RequestContext, branchId?: string) {
  const s = await resolveScope(ctx, { branchId });
  const today = getBusinessDate();
  const monthStart = `${today.slice(0, 7)}-01`;
  const weekStart = addDays(today, -6);
  const match = { businessId: s.businessId, ...branchMatch(s) };

  const [bills, receipts, appointments, approvals, balances, openDues, unreadWaCount] = await Promise.all([
    Bill.find({ ...match, businessDate: { $gte: monthStart < weekStart ? monthStart : weekStart, $lte: today }, status: { $in: EFFECTIVE } }).lean(),
    DueReceipt.find({ ...match, businessDate: today }).lean(),
    Appointment.find({ ...match, businessDate: today }).select('status').lean(),
    Bill.countDocuments({ ...match, status: 'awaiting_approval' }),
    StockBalance.find(match).populate('productId', 'reorderLevels').lean(),
    Due.find({ ...match, status: 'open' }).select('amountPaise settledPaise').lean(),
    WaConversation.countDocuments({ ...match, unread: { $gt: 0 } }),
  ]);

  const todays = bills.filter((b) => b.businessDate === today);
  const mtd = bills.filter((b) => b.businessDate >= monthStart);
  const collections = { cash: 0, upi: 0, card: 0, wallet: 0 } as Record<string, number>;
  for (const b of todays) for (const p of b.payments) if (p.businessDate === today) collections[p.mode] += p.amountPaise;
  for (const r of receipts) for (const p of r.payments) collections[p.mode] = (collections[p.mode] || 0) + p.amountPaise;

  const byStatus: Record<string, number> = {};
  for (const a of appointments) byStatus[a.status] = (byStatus[a.status] || 0) + 1;

  const services = new Map<string, { name: string; count: number; netPaise: number }>();
  for (const b of todays) {
    for (const l of b.lines.filter((x: any) => x.kind === 'service')) {
      const cur = services.get(String(l.refId)) || { name: l.name, count: 0, netPaise: 0 };
      cur.count += l.qty;
      cur.netPaise += l.taxablePaise;
      services.set(String(l.refId), cur);
    }
  }

  const lowStockCount = balances.filter((b: any) => {
    const level = b.productId?.reorderLevels?.find((r: any) => String(r.branchId) === String(b.branchId));
    return level && b.qty <= level.qty;
  }).length;

  const todaySales = sum(todays.map((b) => b.totals.taxablePaise));
  const newCustomers = await Customer.countDocuments({ businessId: s.businessId, 'stats.firstVisit': today, _id: { $in: todays.map((b) => b.customerId) } });

  return {
    date: today,
    branchIds: s.branchIds,
    today: {
      salesPaise: todaySales,
      totalPaise: sum(todays.map((b) => b.totals.totalPaise)),
      billsCount: todays.length,
      customersCount: new Set(todays.map((b) => String(b.customerId))).size,
      newCustomersCount: newCustomers,
      avgTicketSizePaise: todays.length ? Math.round(todaySales / todays.length) : 0,
      appointmentsCount: appointments.length,
      appointmentsByStatus: byStatus,
      collections,
    },
    mtd: {
      from: monthStart,
      salesPaise: sum(mtd.map((b) => b.totals.taxablePaise)),
      totalPaise: sum(mtd.map((b) => b.totals.totalPaise)),
      billsCount: mtd.length,
    },
    last7Days: Array.from({ length: 7 }, (_, i) => {
      const d = addDays(weekStart, i);
      const day = bills.filter((b) => b.businessDate === d);
      return { date: d, salesPaise: sum(day.map((b) => b.totals.taxablePaise)), billsCount: day.length };
    }),
    topServicesToday: [...services.values()].sort((a, b) => b.netPaise - a.netPaise).slice(0, 5),
    pendingApprovalsCount: approvals,
    lowStockCount,
    openDuesPaise: sum(openDues.map((d) => d.amountPaise - d.settledPaise)),
    unreadWaCount,
  };
}

// ----------------------------------------------------
// Reports
// ----------------------------------------------------

export async function generateStandardReport(ctx: RequestContext, reportName: string, params: ReportParams): Promise<any> {
  if (!(REPORT_NAMES as readonly string[]).includes(reportName)) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, `Unknown report: ${reportName}`, { details: { reports: REPORT_NAMES } });
  }
  const s = await resolveScope(ctx, params);
  const head = { report: reportName, from: s.from, to: s.to, branchIds: s.branchIds };
  const names = await branchNames(s);
  const branchLabel = (id: any) => names.get(String(id))?.name || '';

  switch (reportName as ReportName) {
    case 'sales-summary': {
      const [bills, receipts] = await Promise.all([
        billsInRange(s, { withRefundsInRange: true }),
        DueReceipt.find({ businessId: s.businessId, ...branchMatch(s), businessDate: { $gte: s.from, $lte: s.to } }).lean(),
      ]);
      const days = new Map<string, any>();
      const day = (d: string) => {
        if (!days.has(d)) {
          days.set(d, { date: d, bills: 0, customers: new Set<string>(), grossPaise: 0, discountPaise: 0, netPaise: 0, taxPaise: 0, totalPaise: 0, servicesPaise: 0, productsPaise: 0, plansPaise: 0, tipsPaise: 0, cashPaise: 0, upiPaise: 0, cardPaise: 0, walletPaise: 0, duesCollectedPaise: 0, refundsPaise: 0 });
        }
        return days.get(d);
      };
      for (const b of bills) {
        if (EFFECTIVE.includes(b.status) && inRange(b.businessDate, s)) {
          const r = day(b.businessDate);
          r.bills += 1;
          r.customers.add(String(b.customerId));
          r.grossPaise += b.totals.grossPaise;
          r.discountPaise += b.totals.discountPaise;
          r.netPaise += b.totals.taxablePaise;
          r.taxPaise += b.totals.cgstPaise + b.totals.sgstPaise;
          r.totalPaise += b.totals.totalPaise;
          r.servicesPaise += lineKindNet(b, ['service']);
          r.productsPaise += lineKindNet(b, ['product']);
          r.plansPaise += lineKindNet(b, PLAN_KINDS);
          r.tipsPaise += sum((b.tips || []).map((t: any) => t.amountPaise));
          for (const p of b.payments) r[`${p.mode}Paise`] += p.amountPaise;
        }
        for (const rf of b.refunds || []) if (inRange(rf.businessDate, s)) day(rf.businessDate).refundsPaise += rf.amountPaise;
      }
      for (const rc of receipts) {
        const r = day(rc.businessDate);
        for (const p of rc.payments) {
          r[`${p.mode}Paise`] += p.amountPaise;
          r.duesCollectedPaise += p.amountPaise;
        }
      }
      const rows = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({ ...r, customers: r.customers.size }));
      const totals: any = {};
      for (const k of Object.keys(rows[0] || {}).filter((k) => k !== 'date')) totals[k] = sum(rows.map((r: any) => r[k]));
      totals.avgTicketPaise = totals.bills ? Math.round(totals.netPaise / totals.bills) : 0;
      return { ...head, summary: rows.length ? totals : null, rows };
    }

    case 'branch-comparison': {
      const bills = await billsInRange(s);
      const rows = [...names.entries()].map(([id, b]) => {
        const mine = bills.filter((x) => String(x.branchId) === id);
        const net = sum(mine.map((x) => x.totals.taxablePaise));
        return {
          branchId: id,
          branchName: b.name,
          branchCode: b.code,
          bills: mine.length,
          customers: new Set(mine.map((x) => String(x.customerId))).size,
          grossPaise: sum(mine.map((x) => x.totals.grossPaise)),
          discountPaise: sum(mine.map((x) => x.totals.discountPaise)),
          netPaise: net,
          totalPaise: sum(mine.map((x) => x.totals.totalPaise)),
          servicesPaise: sum(mine.map((x) => lineKindNet(x, ['service']))),
          productsPaise: sum(mine.map((x) => lineKindNet(x, ['product']))),
          plansPaise: sum(mine.map((x) => lineKindNet(x, PLAN_KINDS))),
          avgTicketPaise: mine.length ? Math.round(net / mine.length) : 0,
        };
      });
      rows.sort((a, b) => b.netPaise - a.netPaise);
      return { ...head, rows };
    }

    case 'service-profitability': {
      const bills = await billsInRange(s);
      const map = new Map<string, any>();
      for (const b of bills) {
        for (const l of b.lines.filter((x: any) => x.kind === 'service')) {
          const r = map.get(String(l.refId)) || { serviceId: String(l.refId), name: l.name, count: 0, grossPaise: 0, discountPaise: 0, netPaise: 0, commissionPaise: 0, consumableCostPaise: 0 };
          r.count += l.qty;
          r.grossPaise += l.unitPricePaise * l.qty;
          r.discountPaise += l.discountPaise;
          r.netPaise += l.taxablePaise;
          r.commissionPaise += sum((l.staff || []).map((st: any) => st.commissionPaise || 0));
          r.consumableCostPaise += sum((l.consumablesUsed || []).map((c: any) => c.costPaise || 0));
          map.set(String(l.refId), r);
        }
      }
      const rows = [...map.values()]
        .map((r) => ({ ...r, marginPaise: r.netPaise - r.commissionPaise - r.consumableCostPaise }))
        .sort((a, b) => b.netPaise - a.netPaise);
      return { ...head, summary: { netPaise: sum(rows.map((r) => r.netPaise)), marginPaise: sum(rows.map((r) => r.marginPaise)) }, rows };
    }

    case 'product-profitability': {
      const bills = await billsInRange(s);
      const billIds = bills.map((b) => b._id);
      const movements = await StockMovement.find({ businessId: s.businessId, refType: 'bill', refId: { $in: billIds }, type: 'sale' }).lean();
      const costByBillProduct = new Map<string, number>();
      for (const m of movements) {
        const k = `${m.refId}:${m.productId}`;
        costByBillProduct.set(k, (costByBillProduct.get(k) || 0) + (m.costPaise || 0));
      }
      const map = new Map<string, any>();
      for (const b of bills) {
        for (const l of b.lines.filter((x: any) => x.kind === 'product')) {
          const r = map.get(String(l.refId)) || { productId: String(l.refId), name: l.name, qty: 0, netPaise: 0, costPaise: 0, commissionPaise: 0 };
          r.qty += l.qty;
          r.netPaise += l.taxablePaise;
          r.commissionPaise += sum((l.staff || []).map((st: any) => st.commissionPaise || 0));
          r.costPaise += costByBillProduct.get(`${b._id}:${l.refId}`) || 0;
          costByBillProduct.delete(`${b._id}:${l.refId}`); // a product twice on one bill: count its cost once
          map.set(String(l.refId), r);
        }
      }
      const stock = await StockBalance.find({ businessId: s.businessId, ...branchMatch(s), productId: { $in: [...map.keys()].map(toObjectId) }, pool: 'retail' }).lean();
      const rows = [...map.values()]
        .map((r) => ({
          ...r,
          marginPaise: r.netPaise - r.costPaise - r.commissionPaise,
          stockQty: sum(stock.filter((x) => String(x.productId) === r.productId).map((x) => x.qty)),
        }))
        .sort((a, b) => b.netPaise - a.netPaise);
      return { ...head, summary: { netPaise: sum(rows.map((r) => r.netPaise)), marginPaise: sum(rows.map((r) => r.marginPaise)) }, rows };
    }

    case 'customer-retention': {
      const bills = await billsInRange(s);
      const spend = new Map<string, { visits: number; spendPaise: number }>();
      for (const b of bills) {
        const cur = spend.get(String(b.customerId)) || { visits: 0, spendPaise: 0 };
        cur.visits += 1;
        cur.spendPaise += b.totals.totalPaise;
        spend.set(String(b.customerId), cur);
      }
      const customers = await Customer.find({ businessId: s.businessId, _id: { $in: [...spend.keys()].map(toObjectId) } }).select('name stats').lean();
      const isNew = (c: any) => inRange(c.stats?.firstVisit, s);
      const newCount = customers.filter(isNew).length;
      const lapsedCount = await Customer.countDocuments({
        businessId: s.businessId,
        mergedInto: { $exists: false },
        'stats.lastVisit': { $lt: addDays(getBusinessDate(), -60) },
      });
      const rows = customers
        .map((c) => ({ customerId: String(c._id), name: c.name, visits: spend.get(String(c._id))!.visits, spendPaise: spend.get(String(c._id))!.spendPaise, firstVisit: c.stats?.firstVisit, new: isNew(c) }))
        .sort((a, b) => b.spendPaise - a.spendPaise);
      const total = customers.length;
      return {
        ...head,
        summary: {
          customers: total,
          newCustomers: newCount,
          returningCustomers: total - newCount,
          retentionPct: total ? Math.round(((total - newCount) / total) * 100) : 0,
          lapsedCustomers: lapsedCount,
        },
        rows,
      };
    }

    case 'membership-liability': {
      // What the salon still owes in services/credit as of today (not limited by dates)
      const [walletCustomers, plans] = await Promise.all([
        Customer.find({ businessId: s.businessId, walletBalancePaise: { $gt: 0 } }).select('name walletBalancePaise').lean(),
        CustomerPlan.find({ businessId: s.businessId, status: { $in: ['active', 'frozen'] }, ...branchMatch(s, 'soldBranchId') }).lean(),
      ]);
      const packages = plans.filter((p: any) => p.planSnap?.type === 'package');
      const vouchers = plans.filter((p: any) => p.planSnap?.type === 'voucher');
      const memberships = plans.filter((p: any) => p.planSnap?.type === 'membership');
      const packageValue = (p: any) => sum((p.sessions || []).map((x: any) => (x.total - x.used) * x.perSessionValuePaise));
      const rows = [
        { type: 'wallet', count: walletCustomers.length, liabilityPaise: sum(walletCustomers.map((c) => c.walletBalancePaise)) },
        { type: 'package', count: packages.length, liabilityPaise: sum(packages.map(packageValue)), unusedSessions: sum(packages.map((p: any) => sum((p.sessions || []).map((x: any) => x.total - x.used)))) },
        { type: 'voucher', count: vouchers.length, liabilityPaise: sum(vouchers.map((v: any) => v.planSnap?.voucher?.valuePaise || 0)) },
        { type: 'membership', count: memberships.length, liabilityPaise: 0 },
      ];
      return { ...head, asOf: getBusinessDate(), summary: { liabilityPaise: sum(rows.map((r) => r.liabilityPaise)) }, rows };
    }

    case 'staff-performance': {
      const [bills, staff] = await Promise.all([
        billsInRange(s),
        Staff.find({ businessId: s.businessId, ...branchMatch(s) }).select('name designation branchId status').lean(),
      ]);
      const map = new Map<string, any>(
        staff.map((st) => [String(st._id), { staffId: String(st._id), name: st.name, designation: st.designation, branch: branchLabel(st.branchId), services: 0, serviceSalesPaise: 0, productSalesPaise: 0, commissionPaise: 0, tipsPaise: 0 }])
      );
      for (const b of bills) {
        for (const l of b.lines) {
          for (const st of l.staff || []) {
            const r = map.get(String(st.staffId));
            if (!r) continue;
            const share = Math.round((l.taxablePaise * (st.splitBps || 10000)) / 10000);
            if (l.kind === 'service') {
              r.services += l.qty;
              r.serviceSalesPaise += share;
            } else if (l.kind === 'product') {
              r.productSalesPaise += share;
            }
            r.commissionPaise += st.commissionPaise || 0;
          }
        }
        for (const t of b.tips || []) {
          const r = map.get(String(t.staffId));
          if (r) r.tipsPaise += t.amountPaise;
        }
      }
      const rows = [...map.values()].sort((a, b) => b.serviceSalesPaise + b.productSalesPaise - (a.serviceSalesPaise + a.productSalesPaise));
      return { ...head, rows };
    }

    case 'attendance-payroll': {
      const [staff, attendance, runs] = await Promise.all([
        Staff.find({ businessId: s.businessId, ...branchMatch(s) }).select('name designation branchId').lean(),
        Attendance.find({ businessId: s.businessId, ...branchMatch(s), businessDate: { $gte: s.from, $lte: s.to } }).lean(),
        PayrollRun.find({ businessId: s.businessId, ...branchMatch(s), month: { $gte: s.from.slice(0, 7), $lte: s.to.slice(0, 7) } }).lean(),
      ]);
      const rows = staff.map((st) => {
        const mine = attendance.filter((a) => String(a.staffId) === String(st._id));
        const count = (status: string) => mine.filter((a) => a.status === status).length;
        const lines = runs.flatMap((r: any) => r.lines.filter((l: any) => String(l.staffId) === String(st._id)).map((l: any) => ({ ...l, status: r.status })));
        return {
          staffId: String(st._id),
          name: st.name,
          designation: st.designation,
          branch: branchLabel(st.branchId),
          present: count('present'),
          late: count('late'),
          halfDay: count('half_day'),
          absent: count('absent'),
          leave: count('leave'),
          weekOff: count('week_off'),
          holiday: count('holiday'),
          overtimeMin: sum(mine.map((a) => a.overtimeMin || 0)),
          payrollNetPaise: sum(lines.map((l: any) => l.netPaise)),
          payrollStatus: [...new Set(lines.map((l: any) => l.status))].join(', ') || null,
        };
      });
      return { ...head, runs: runs.map((r: any) => ({ runId: r._id, branch: branchLabel(r.branchId), month: r.month, status: r.status, netPaise: r.totals.netPaise })), rows };
    }

    case 'inventory-valuation': {
      const balances = await StockBalance.find({ businessId: s.businessId, ...branchMatch(s) })
        .populate('productId', 'name brand type useUnit purchasePricePaise unitsPerPurchase')
        .lean();
      const rows = balances.map((b: any) => {
        const p = b.productId || {};
        const unitCostPaise = (p.purchasePricePaise || 0) / (p.unitsPerPurchase || 1);
        return {
          productId: String(p._id),
          name: p.name,
          brand: p.brand,
          branch: branchLabel(b.branchId),
          pool: b.pool,
          qty: b.qty,
          useUnit: p.useUnit,
          unitCostPaise: Math.round(unitCostPaise),
          valuePaise: Math.round(unitCostPaise * Math.max(0, b.qty)),
        };
      });
      return {
        ...head,
        asOf: getBusinessDate(),
        summary: {
          retailPaise: sum(rows.filter((r) => r.pool === 'retail').map((r) => r.valuePaise)),
          consumablePaise: sum(rows.filter((r) => r.pool === 'consumable').map((r) => r.valuePaise)),
          totalPaise: sum(rows.map((r) => r.valuePaise)),
          negativeLines: rows.filter((r) => r.qty < 0).length,
        },
        rows,
      };
    }

    case 'discounts-cancellations': {
      const bills = await billsInRange(s, { withRefundsInRange: true });
      const dated = bills.filter((b) => inRange(b.businessDate, s));
      const discounted = dated
        .filter((b) => EFFECTIVE.includes(b.status) && b.totals.discountPaise > 0)
        .map((b) => ({
          invoiceNo: b.invoiceNo,
          date: b.businessDate,
          branch: branchLabel(b.branchId),
          billedBy: b.billedByName,
          customer: b.customerSnap?.name,
          grossPaise: b.totals.grossPaise,
          discountPaise: b.totals.discountPaise,
          discountPct: b.totals.grossPaise ? Math.round((b.totals.discountPaise * 10000) / b.totals.grossPaise) / 100 : 0,
          approved: !!b.approval?.decidedAt,
        }));
      const cancelled = dated
        .filter((b) => b.status === 'cancelled')
        .map((b) => ({ invoiceNo: b.invoiceNo, date: b.businessDate, branch: branchLabel(b.branchId), totalPaise: b.totals.totalPaise, reason: b.cancel?.reason, cancelledAt: b.cancel?.at }));
      const refunds = bills.flatMap((b) =>
        (b.refunds || []).filter((r: any) => inRange(r.businessDate, s)).map((r: any) => ({ invoiceNo: b.invoiceNo, billDate: b.businessDate, refundDate: r.businessDate, amountPaise: r.amountPaise, mode: r.mode, reason: r.reason }))
      );
      const byBilledBy = new Map<string, { billedBy: string; bills: number; discountPaise: number }>();
      for (const d of discounted) {
        const k = d.billedBy || '—';
        const cur = byBilledBy.get(k) || { billedBy: k, bills: 0, discountPaise: 0 };
        cur.bills += 1;
        cur.discountPaise += d.discountPaise;
        byBilledBy.set(k, cur);
      }
      return {
        ...head,
        summary: {
          discountedBills: discounted.length,
          discountPaise: sum(discounted.map((d) => d.discountPaise)),
          cancelledBills: cancelled.length,
          cancelledPaise: sum(cancelled.map((c) => c.totalPaise)),
          refunds: refunds.length,
          refundsPaise: sum(refunds.map((r) => r.amountPaise)),
        },
        byBilledBy: [...byBilledBy.values()].sort((a, b) => b.discountPaise - a.discountPaise),
        rows: discounted,
        sheets: { Discounts: discounted, Cancellations: cancelled, Refunds: refunds },
      };
    }

    case 'expenses-pnl': {
      const [bills, expenses, runs] = await Promise.all([
        billsInRange(s, { withRefundsInRange: true }),
        Expense.find({ businessId: s.businessId, ...branchMatch(s), businessDate: { $gte: s.from, $lte: s.to }, deletedAt: null }).lean(),
        PayrollRun.find({ businessId: s.businessId, ...branchMatch(s), month: { $gte: s.from.slice(0, 7), $lte: s.to.slice(0, 7) }, status: { $in: ['locked', 'paid'] } }).lean(),
      ]);
      const sales = bills.filter((b) => EFFECTIVE.includes(b.status) && inRange(b.businessDate, s));
      const productMoves = await StockMovement.find({ businessId: s.businessId, refType: 'bill', refId: { $in: sales.map((b) => b._id) }, type: 'sale' }).lean();
      const revenuePaise = sum(sales.map((b) => b.totals.taxablePaise));
      const refundsPaise = sum(bills.flatMap((b) => (b.refunds || []).filter((r: any) => inRange(r.businessDate, s)).map((r: any) => r.amountPaise)));
      const productCostPaise = sum(productMoves.map((m) => m.costPaise || 0));
      const consumableCostPaise = sum(sales.flatMap((b) => b.lines.flatMap((l: any) => (l.consumablesUsed || []).map((c: any) => c.costPaise || 0))));
      const commissionPaise = sum(sales.flatMap((b) => b.lines.flatMap((l: any) => (l.staff || []).map((st: any) => st.commissionPaise || 0))));
      const salariesPaise = sum(runs.flatMap((r: any) => r.lines.map((l: any) => l.salaryPaise + l.overtimePaise + (l.incentivesPaise || 0))));
      const byCategory = new Map<string, number>();
      for (const e of expenses) byCategory.set(e.category, (byCategory.get(e.category) || 0) + e.amountPaise);
      const expensesPaise = sum(expenses.map((e) => e.amountPaise));
      const grossProfitPaise = revenuePaise - refundsPaise - productCostPaise - consumableCostPaise;
      const netProfitPaise = grossProfitPaise - commissionPaise - salariesPaise - expensesPaise;
      const rows = [
        { item: 'Revenue (net of discounts, before GST)', amountPaise: revenuePaise },
        { item: 'Refunds paid', amountPaise: -refundsPaise },
        { item: 'Cost of products sold', amountPaise: -productCostPaise },
        { item: 'Consumables used in services', amountPaise: -consumableCostPaise },
        { item: 'Gross profit', amountPaise: grossProfitPaise },
        { item: 'Staff commission', amountPaise: -commissionPaise },
        { item: 'Salaries (locked payroll runs in these months)', amountPaise: -salariesPaise },
        ...[...byCategory.entries()].map(([category, amount]) => ({ item: `Expense: ${category}`, amountPaise: -amount })),
        { item: 'Net profit', amountPaise: netProfitPaise },
      ];
      return {
        ...head,
        summary: { revenuePaise, refundsPaise, productCostPaise, consumableCostPaise, grossProfitPaise, commissionPaise, salariesPaise, expensesPaise, netProfitPaise },
        rows,
      };
    }

    case 'day-closures': {
      const closures = await DayClosure.find({ businessId: s.businessId, ...branchMatch(s), businessDate: { $gte: s.from, $lte: s.to } })
        .sort({ businessDate: -1 })
        .lean();
      const rows = closures.map((c: any) => ({
        date: c.businessDate,
        branch: branchLabel(c.branchId),
        status: c.status,
        expectedCashPaise: c.expected?.cashPaise ?? 0,
        countedCashPaise: c.counted?.cashPaise ?? null,
        diffCashPaise: c.diff?.cashPaise ?? null,
        expectedUpiPaise: c.expected?.upiPaise ?? 0,
        diffUpiPaise: c.diff?.upiPaise ?? null,
        expectedCardPaise: c.expected?.cardPaise ?? 0,
        diffCardPaise: c.diff?.cardPaise ?? null,
        diffReason: c.diffReason || null,
        reopened: (c.reopenLog || []).length,
      }));
      return { ...head, summary: { days: rows.length, approved: rows.filter((r) => r.status === 'approved').length, cashDiffPaise: sum(rows.map((r) => r.diffCashPaise || 0)) }, rows };
    }

    case 'gstr-1': {
      const business = await Business.findById(s.businessId).select('gst address');
      if (!business?.gst?.enabled) {
        throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'GSTR-1 is only available when GST is enabled for the business');
      }
      const bills = await Bill.find({ businessId: s.businessId, ...branchMatch(s), businessDate: { $gte: s.from, $lte: s.to }, status: { $in: EFFECTIVE }, gstApplied: true }).lean();
      const invoices = bills.map((b) => ({
        invoiceNo: b.invoiceNo,
        date: b.businessDate,
        branch: branchLabel(b.branchId),
        customer: b.customerSnap?.name,
        placeOfSupply: business.address?.state,
        taxablePaise: b.totals.taxablePaise,
        cgstPaise: b.totals.cgstPaise,
        sgstPaise: b.totals.sgstPaise,
        totalPaise: b.totals.totalPaise,
      }));
      // B2C summary by rate, and the HSN/SAC summary (Table 12)
      const byRate = new Map<number, any>();
      const byHsn = new Map<string, any>();
      for (const b of bills) {
        for (const l of b.lines.filter((x: any) => x.gstBps > 0)) {
          const r = byRate.get(l.gstBps) || { ratePct: l.gstBps / 100, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 };
          r.taxablePaise += l.taxablePaise;
          r.cgstPaise += l.cgstPaise;
          r.sgstPaise += l.sgstPaise;
          byRate.set(l.gstBps, r);
          const key = `${l.hsnSac || ''}:${l.gstBps}`;
          const h = byHsn.get(key) || { hsnSac: l.hsnSac || '', ratePct: l.gstBps / 100, qty: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 };
          h.qty += l.qty;
          h.taxablePaise += l.taxablePaise;
          h.cgstPaise += l.cgstPaise;
          h.sgstPaise += l.sgstPaise;
          byHsn.set(key, h);
        }
      }
      const b2cs = [...byRate.values()];
      const hsn = [...byHsn.values()];
      return {
        ...head,
        gstin: business.gst.gstin,
        summary: {
          invoices: invoices.length,
          taxablePaise: sum(invoices.map((i) => i.taxablePaise)),
          cgstPaise: sum(invoices.map((i) => i.cgstPaise)),
          sgstPaise: sum(invoices.map((i) => i.sgstPaise)),
        },
        b2b: [], // customer GSTINs are not captured on bills yet, so every invoice is B2C
        b2cs,
        hsn,
        rows: invoices,
        sheets: { Invoices: invoices, 'B2C by rate': b2cs, 'HSN summary': hsn },
      };
    }

    case 'leads-conversion': {
      const leads = await Lead.find({ businessId: s.businessId, ...branchMatch(s) });
      const total = leads.length;
      const booked = leads.filter((l) => l.stage === 'booked').length;
      const lost = leads.filter((l) => l.stage === 'lost').length;
      return { ...head, summary: { totalLeads: total, bookedLeads: booked, lostLeads: lost, conversionRatePct: total > 0 ? Math.round((booked / total) * 100) : 0 }, rows: [] };
    }

    case 'whatsapp-spend': {
      const campaigns = await Campaign.find({ businessId: s.businessId });
      return {
        ...head,
        summary: {
          totalCampaigns: campaigns.length,
          totalSent: sum(campaigns.map((c) => c.stats?.sent || 0)),
          totalCostPaise: sum(campaigns.map((c) => c.stats?.costPaise || 0)),
        },
        rows: [],
      };
    }
  }
}

// ----------------------------------------------------
// Excel Export
// ----------------------------------------------------

/** Column header for a field: "netPaise" -> "Net (Rs.)", "date" -> "Date". */
const header = (key: string) => {
  const money = key.endsWith('Paise');
  const base = (money ? key.slice(0, -5) : key).replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  return money ? `${base} (Rs.)` : base;
};

function addSheet(workbook: ExcelJS.Workbook, name: string, rows: any[]) {
  const sheet = workbook.addWorksheet(name.slice(0, 31));
  if (!rows.length) {
    sheet.addRow(['No data for this period']);
    return;
  }
  const keys = Object.keys(rows[0]).filter((k) => typeof rows[0][k] !== 'object' || rows[0][k] === null);
  sheet.columns = keys.map((key) => ({ header: header(key), key, width: Math.max(12, header(key).length + 2), style: key.endsWith('Paise') ? { numFmt: '#,##0.00' } : {} }));
  for (const row of rows) {
    sheet.addRow(Object.fromEntries(keys.map((k) => [k, k.endsWith('Paise') && typeof row[k] === 'number' ? row[k] / 100 : row[k]])));
  }
  sheet.getRow(1).font = { bold: true };
}

export async function exportReportToExcel(ctx: RequestContext, reportName: string, params: ReportParams): Promise<Buffer> {
  const data = await generateStandardReport(ctx, reportName, params);
  const workbook = new ExcelJS.Workbook();

  const summary = [
    { metric: 'Report', value: reportName },
    { metric: 'From', value: data.from },
    { metric: 'To', value: data.to },
    ...Object.entries(data.summary || {}).map(([k, v]) => ({ metric: header(k), value: k.endsWith('Paise') && typeof v === 'number' ? v / 100 : v })),
  ];
  addSheet(workbook, 'Summary', summary);
  if (data.sheets) {
    for (const [name, rows] of Object.entries<any[]>(data.sheets)) addSheet(workbook, name, rows);
  } else {
    addSheet(workbook, 'Report', data.rows || []);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
