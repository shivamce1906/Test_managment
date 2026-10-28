import { Types } from 'mongoose';
import {
  DailySummary,
  Bill,
  Appointment,
  Customer,
  StockBalance,
  Product,
  Staff,
  Expense,
  PayrollRun,
  DayClosure,
  Lead,
  Campaign,
  WaConversation,
} from '../models';
import { AppError, ErrorCode, getBusinessDate, paiseToRupees } from '../utils';
import { RequestContext, toObjectId } from './context';
import ExcelJS from 'exceljs';

// ----------------------------------------------------
// Dashboard KPIs
// ----------------------------------------------------

export async function getDashboardKPIs(
  ctx: RequestContext,
  branchId?: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const today = getBusinessDate();
  const currentMonth = today.slice(0, 7);

  const query: any = { businessId: toObjectId(ctx.businessId) };
  if (branchId) query.branchId = toObjectId(branchId);

  // 1. Today's summary
  const todaySummaries = await DailySummary.find({ ...query, businessDate: today });
  let todaySalesPaise = 0;
  let todayBillsCount = 0;
  let todayCustomersCount = 0;

  for (const s of todaySummaries) {
    todaySalesPaise += s.sales.netPaise;
    todayBillsCount += s.counts.bills;
    todayCustomersCount += s.counts.customers;
  }

  // 2. MTD Sales
  const mtdSummaries = await DailySummary.find({
    ...query,
    businessDate: { $gte: `${currentMonth}-01`, $lte: today },
  });

  let mtdSalesPaise = 0;
  let mtdBillsCount = 0;

  for (const s of mtdSummaries) {
    mtdSalesPaise += s.sales.netPaise;
    mtdBillsCount += s.counts.bills;
  }

  const avgTicketSizePaise = todayBillsCount > 0 ? Math.round(todaySalesPaise / todayBillsCount) : 0;

  // 3. Today's appointments
  const aptQuery: any = { businessId: toObjectId(ctx.businessId), date: today };
  if (branchId) aptQuery.branchId = toObjectId(branchId);
  const todayAppointmentsCount = await Appointment.countDocuments(aptQuery);

  // 4. Low stock products
  const stockBalances = await StockBalance.find(query).populate('productId');
  let lowStockCount = 0;
  for (const sb of stockBalances) {
    const prod: any = sb.productId;
    if (prod && prod.reorderLevels) {
      const matchLevel = prod.reorderLevels.find((r: any) => r.branchId?.toString() === sb.branchId?.toString());
      if (matchLevel && sb.qty <= matchLevel.qty) {
        lowStockCount++;
      }
    }
  }

  // 5. Unread WhatsApp conversations
  const convQuery: any = { businessId: toObjectId(ctx.businessId), unread: { $gt: 0 } };
  if (branchId) convQuery.branchId = toObjectId(branchId);
  const unreadWaCount = await WaConversation.countDocuments(convQuery);

  return {
    today: {
      salesPaise: todaySalesPaise,
      billsCount: todayBillsCount,
      customersCount: todayCustomersCount,
      avgTicketSizePaise,
      appointmentsCount: todayAppointmentsCount,
    },
    mtd: {
      salesPaise: mtdSalesPaise,
      billsCount: mtdBillsCount,
    },
    lowStockCount,
    unreadWaCount,
  };
}

// ----------------------------------------------------
// Daily Summaries Reader
// ----------------------------------------------------

export async function getDailySummaries(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  fromDate: string,
  toDate: string
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  return DailySummary.find({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    businessDate: { $gte: fromDate, $lte: toDate },
  }).sort({ businessDate: 1 });
}

// ----------------------------------------------------
// 15 Standard Reports Engine
// ----------------------------------------------------

export async function generateStandardReport(
  ctx: RequestContext,
  reportName: string,
  params: {
    branchId?: string | Types.ObjectId;
    fromDate?: string;
    toDate?: string;
  }
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const fromDate = params.fromDate || getBusinessDate();
  const toDate = params.toDate || getBusinessDate();

  const query: any = { businessId: toObjectId(ctx.businessId) };
  if (params.branchId) query.branchId = toObjectId(params.branchId);

  switch (reportName) {
    case 'sales-summary': {
      const summaries = await DailySummary.find({
        ...query,
        businessDate: { $gte: fromDate, $lte: toDate },
      }).sort({ businessDate: 1 });

      return summaries.map((s) => ({
        businessDate: s.businessDate,
        branchId: s.branchId,
        grossPaise: s.sales.grossPaise,
        discountPaise: s.sales.discountPaise,
        netPaise: s.sales.netPaise,
        taxPaise: s.sales.taxPaise,
        cashPaise: s.collections.cash,
        upiPaise: s.collections.upi,
        cardPaise: s.collections.card,
        walletPaise: s.collections.wallet,
        billsCount: s.counts.bills,
      }));
    }

    case 'branch-comparison': {
      const summaries = await DailySummary.find({
        businessId: toObjectId(ctx.businessId),
        businessDate: { $gte: fromDate, $lte: toDate },
      });

      const branchMap = new Map<string, any>();
      for (const s of summaries) {
        const bId = s.branchId.toString();
        const current = branchMap.get(bId) || {
          branchId: s.branchId,
          grossPaise: 0,
          netPaise: 0,
          billsCount: 0,
          customersCount: 0,
        };
        current.grossPaise += s.sales.grossPaise;
        current.netPaise += s.sales.netPaise;
        current.billsCount += s.counts.bills;
        current.customersCount += s.counts.customers;
        branchMap.set(bId, current);
      }

      return Array.from(branchMap.values()).map((b) => ({
        ...b,
        avgTicketPaise: b.billsCount > 0 ? Math.round(b.netPaise / b.billsCount) : 0,
      }));
    }

    case 'service-profitability': {
      const summaries = await DailySummary.find({
        ...query,
        businessDate: { $gte: fromDate, $lte: toDate },
      });

      const serviceMap = new Map<string, { count: number; netPaise: number }>();
      for (const s of summaries) {
        if (s.byService) {
          for (const [srvId, data] of Object.entries(s.byService)) {
            const cur = serviceMap.get(srvId) || { count: 0, netPaise: 0 };
            cur.count += (data as any).count || 0;
            cur.netPaise += (data as any).netPaise || 0;
            serviceMap.set(srvId, cur);
          }
        }
      }

      return Array.from(serviceMap.entries()).map(([serviceId, stats]) => ({
        serviceId,
        count: stats.count,
        netPaise: stats.netPaise,
      }));
    }

    case 'product-profitability': {
      const products = await Product.find({ businessId: toObjectId(ctx.businessId) });
      const balances = await StockBalance.find(query);
      const balanceMap = new Map(balances.map((b) => [b.productId.toString(), b.qty]));

      return products.map((p) => ({
        productId: p._id,
        name: p.name,
        pool: p.type,
        mrpPaise: p.mrpPaise || p.sellingPricePaise || 0,
        currentStock: balanceMap.get(p._id.toString()) || 0,
      }));
    }

    case 'customer-retention': {
      const summaries = await DailySummary.find({
        ...query,
        businessDate: { $gte: fromDate, $lte: toDate },
      });

      let totalCust = 0;
      let newCust = 0;
      for (const s of summaries) {
        totalCust += s.counts.customers;
        newCust += s.counts.newCustomers;
      }
      const returningCust = Math.max(0, totalCust - newCust);
      const retentionPct = totalCust > 0 ? Math.round((returningCust / totalCust) * 100) : 0;

      return {
        totalCustomers: totalCust,
        newCustomers: newCust,
        returningCustomers: returningCust,
        retentionPercentage: retentionPct,
      };
    }

    case 'membership-liability': {
      const customers = await Customer.find({ businessId: toObjectId(ctx.businessId) });
      let totalWalletLiabilityPaise = 0;
      let customersWithWallet = 0;

      for (const c of customers) {
        if (c.walletBalancePaise > 0) {
          totalWalletLiabilityPaise += c.walletBalancePaise;
          customersWithWallet++;
        }
      }

      return {
        totalWalletLiabilityPaise,
        customersWithWallet,
      };
    }

    case 'staff-performance': {
      const summaries = await DailySummary.find({
        ...query,
        businessDate: { $gte: fromDate, $lte: toDate },
      });

      const staffMap = new Map<string, { netPaise: number; commissionPaise: number }>();
      for (const s of summaries) {
        if (s.byStaff) {
          for (const [stfId, data] of Object.entries(s.byStaff)) {
            const cur = staffMap.get(stfId) || { netPaise: 0, commissionPaise: 0 };
            cur.netPaise += (data as any).netPaise || 0;
            cur.commissionPaise += (data as any).commissionPaise || 0;
            staffMap.set(stfId, cur);
          }
        }
      }

      return Array.from(staffMap.entries()).map(([staffId, stats]) => ({
        staffId,
        salesPaise: stats.netPaise,
        commissionPaise: stats.commissionPaise,
      }));
    }

    case 'attendance-payroll': {
      const runs = await PayrollRun.find({
        ...query,
        month: { $gte: fromDate.slice(0, 7), $lte: toDate.slice(0, 7) },
      });

      return runs.map((r) => ({
        runId: r._id,
        branchId: r.branchId,
        month: r.month,
        status: r.status,
        netPaise: r.totals.netPaise,
        staffCount: r.lines.length,
      }));
    }

    case 'inventory-valuation': {
      const balances = await StockBalance.find(query).populate('productId');
      let totalValuationPaise = 0;

      const items = balances.map((b) => {
        const prod: any = b.productId;
        const rate = prod?.purchasePricePaise || prod?.mrpPaise || 0;
        const lineVal = b.qty * rate;
        totalValuationPaise += lineVal;
        return {
          productId: prod?._id,
          productName: prod?.name,
          pool: b.pool,
          qty: b.qty,
          unitValuationPaise: rate,
          lineValuationPaise: lineVal,
        };
      });

      return { items, totalValuationPaise };
    }

    case 'discounts-cancellations': {
      const cancelledBills = await Bill.find({
        ...query,
        businessDate: { $gte: fromDate, $lte: toDate },
        status: 'cancelled',
      });

      const discountedBills = await Bill.find({
        ...query,
        businessDate: { $gte: fromDate, $lte: toDate },
        'totals.discountPaise': { $gt: 0 },
      });

      return {
        cancelledBillsCount: cancelledBills.length,
        cancelledBills: cancelledBills.map((b) => ({
          invoiceNo: b.invoiceNo,
          totals: b.totals,
          cancel: b.cancel,
        })),
        discountedBillsCount: discountedBills.length,
      };
    }

    case 'expenses-pnl': {
      const summaries = await DailySummary.find({
        ...query,
        businessDate: { $gte: fromDate, $lte: toDate },
      });
      let totalRevenuePaise = 0;
      for (const s of summaries) {
        totalRevenuePaise += s.sales.netPaise;
      }

      const expenses = await Expense.find({
        ...query,
        businessDate: { $gte: fromDate, $lte: toDate },
        deletedAt: { $exists: false },
      });
      let totalExpensesPaise = 0;
      for (const e of expenses) {
        totalExpensesPaise += e.amountPaise;
      }

      return {
        revenuePaise: totalRevenuePaise,
        expensesPaise: totalExpensesPaise,
        netProfitPaise: totalRevenuePaise - totalExpensesPaise,
      };
    }

    case 'day-closures': {
      return DayClosure.find({
        ...query,
        businessDate: { $gte: fromDate, $lte: toDate },
      }).sort({ businessDate: -1 });
    }

    case 'leads-conversion': {
      const leads = await Lead.find(query);
      let total = leads.length;
      let booked = leads.filter((l) => l.stage === 'booked').length;
      let lost = leads.filter((l) => l.stage === 'lost').length;

      return {
        totalLeads: total,
        bookedLeads: booked,
        lostLeads: lost,
        conversionRatePct: total > 0 ? Math.round((booked / total) * 100) : 0,
      };
    }

    case 'whatsapp-spend': {
      const campaigns = await Campaign.find(query);
      let totalCostPaise = 0;
      let totalSent = 0;
      for (const c of campaigns) {
        totalCostPaise += c.stats?.costPaise || 0;
        totalSent += c.stats?.sent || 0;
      }
      return { totalCampaigns: campaigns.length, totalSent, totalCostPaise };
    }

    case 'gstr-1': {
      const bills = await Bill.find({
        ...query,
        businessDate: { $gte: fromDate, $lte: toDate },
        status: { $in: ['paid', 'partly_paid'] },
        gstApplied: true,
      });

      const b2b: any[] = [];
      const b2c: any[] = [];

      for (const bill of bills) {
        const taxable = bill.totals.grossPaise - bill.totals.discountPaise;
        const entry = {
          invoiceNo: bill.invoiceNo,
          businessDate: bill.businessDate,
          customerGstin: bill.customerSnap?.gstin,
          taxableValuePaise: taxable,
          cgstPaise: bill.totals.cgstPaise,
          sgstPaise: bill.totals.sgstPaise,
          totalPaise: bill.totals.totalPaise,
        };
        if (bill.customerSnap?.gstin) {
          b2b.push(entry);
        } else {
          b2c.push(entry);
        }
      }

      return { b2b, b2c };
    }

    default:
      throw new AppError(400, ErrorCode.BAD_REQUEST, `Unknown report: ${reportName}`);
  }
}

// ----------------------------------------------------
// Excel Export
// ----------------------------------------------------

export async function exportReportToExcel(
  ctx: RequestContext,
  reportName: string,
  params: {
    branchId?: string | Types.ObjectId;
    fromDate?: string;
    toDate?: string;
  }
): Promise<Buffer> {
  const data = await generateStandardReport(ctx, reportName, params);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(reportName);

  if (Array.isArray(data) && data.length > 0) {
    const keys = Object.keys(data[0]);
    sheet.columns = keys.map((key) => ({
      header: key,
      key,
      width: 20,
    }));
    for (const row of data) {
      sheet.addRow(row);
    }
  } else if (typeof data === 'object' && data !== null) {
    sheet.columns = [
      { header: 'Metric', key: 'metric', width: 30 },
      { header: 'Value', key: 'value', width: 30 },
    ];
    for (const [key, val] of Object.entries(data)) {
      sheet.addRow({
        metric: key,
        value: typeof val === 'object' ? JSON.stringify(val) : val,
      });
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
