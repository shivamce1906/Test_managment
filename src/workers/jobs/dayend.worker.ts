import { Worker, Job } from 'bullmq';
import { getBullConnection, generateDayEndPdf, s3Adapter } from '../../integrations';
import {
  Business,
  Branch,
  Bill,
  DailySummary,
  WaMessage,
  WaConversation,
  WaNumber,
  WaTemplate,
  User,
  Appointment,
  Expense,
  DayClosure,
  DueReceipt,
  AutomationSend,
} from '../../models';
import { logger, getBusinessDate, addDays } from '../../utils';
import { toObjectId } from '../../services';
import { whatsappSendQueue } from '../queues';

function isWithinReportWindowIst(dayEndReportTime: string | undefined, now: Date = new Date()): boolean {
  const target = dayEndReportTime && /^\d{1,2}:\d{2}$/.test(dayEndReportTime) ? dayEndReportTime : '23:00';
  const [th, tm] = target.split(':').map(Number);
  const targetMin = th * 60 + tm;
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const curMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const diff = (curMin - targetMin + 24 * 60) % (24 * 60);
  return diff >= 0 && diff < 15;
}

export function createDayEndWorker(): Worker {
  const connection = getBullConnection();

  return new Worker(
    'day-end-report',
    async (job: Job<{ businessId?: string; date?: string; branchId?: string; scheduled?: boolean }>) => {
      const { businessId, date: requestedDate, branchId: requestedBranchId, scheduled } = job.data || {};
      const now = new Date();
      const date = requestedDate || getBusinessDate(now);
      logger.info({ businessId, date, branchId: requestedBranchId, scheduled }, 'Generating day-end-report job');

      const businesses = businessId
        ? await Business.find({ _id: toObjectId(businessId), status: 'active' })
        : await Business.find({ status: 'active' });

      for (const business of businesses) {
        if (scheduled && !businessId && !isWithinReportWindowIst(business.dayEndReportTime, now)) {
          continue;
        }

        const bId = business._id;
        const waNumber = await WaNumber.findOne({ businessId: bId, status: 'active' });

        const owner = await User.findOne({ businessId: bId, role: 'owner', status: 'active' });
        const ownerPhone = business.ownerWhatsappPhone || owner?.phone;
        if (!ownerPhone || !waNumber) continue;

        const dayEndTpl = await WaTemplate.findOne({
          businessId: bId,
          numberId: waNumber._id,
          name: 'day_end_report',
          status: 'approved',
        });

        const branchFilter: any = { businessId: bId, status: 'active' };
        if (requestedBranchId) {
          branchFilter._id = toObjectId(requestedBranchId);
        }
        const branches = await Branch.find(branchFilter);

        for (const branch of branches) {
          const bills = await Bill.find({
            businessId: bId,
            branchId: branch._id,
            businessDate: date,
            status: { $in: ['paid', 'partly_paid'] },
          });

          const totalRevenuePaise = bills.reduce((acc, b) => acc + (b.totals?.totalPaise || 0), 0);
          const grossSalesPaise = bills.reduce((acc, b) => acc + (b.totals?.grossPaise || 0), 0);
          const discountPaise = bills.reduce((acc, b) => acc + (b.totals?.discountPaise || 0), 0);

          let cashPaise = 0;
          let upiPaise = 0;
          let cardPaise = 0;
          let walletPaise = 0;

          for (const b of bills) {
            for (const p of b.payments || []) {
              if (p.mode === 'cash') cashPaise += p.amountPaise;
              else if (p.mode === 'upi') upiPaise += p.amountPaise;
              else if (p.mode === 'card') cardPaise += p.amountPaise;
              else if (p.mode === 'wallet') walletPaise += p.amountPaise;
            }
          }

          const billCount = bills.length;

          // Appointments statistics
          const appts = await Appointment.find({
            businessId: bId,
            branchId: branch._id,
            businessDate: date,
          });
          const completedAppts = appts.filter((a) => a.status === 'completed' || a.status === 'billed').length;
          const cancelledAppts = appts.filter((a) => a.status === 'cancelled' || a.status === 'no_show').length;

          // Day closure details if already submitted/approved
          const closure = await DayClosure.findOne({
            businessId: bId,
            branchId: branch._id,
            businessDate: date,
          });

          const closureStatusLabel = closure ? closure.status : 'Not closed';
          const expectedCashPaise = closure?.expected?.cashPaise ?? cashPaise;
          const countedCashPaise = closure ? (closure.counted?.cashPaise ?? expectedCashPaise) : 0;
          const diffCashPaise = closure?.diff?.cashPaise ?? 0;

          // Expenses
          const expenses = await Expense.find({
            businessId: bId,
            branchId: branch._id,
            businessDate: date,
          });
          const totalExpensePaise = expenses.reduce((acc, e) => acc + (e.amountPaise || 0), 0);

          let s3Key: string | undefined;
          try {
            const pdfBuffer = await generateDayEndPdf({
              branchName: branch.name,
              businessDate: date,
              expectedCashPaise,
              countedCashPaise,
              diffCashPaise,
              upiPaise,
              cardPaise,
            });

            s3Key = `reports/${bId}/${branch._id}/dayend-${date}.pdf`;
            await s3Adapter.uploadBuffer(s3Key, pdfBuffer, 'application/pdf');
          } catch (pdfErr) {
            logger.warn({ pdfErr, branchId: branch._id }, 'Could not generate DayEnd PDF buffer');
          }

          let conversation = await WaConversation.findOne({
            businessId: bId,
            numberId: waNumber._id,
            phone: ownerPhone,
          });

          if (!conversation) {
            conversation = await WaConversation.create({
              businessId: bId,
              numberId: waNumber._id,
              branchId: branch._id,
              phone: ownerPhone,
              lastMessageAt: new Date(),
              unread: 0,
            });
          }

          const reportText = [
            `📊 *DAY END REPORT - ${branch.name}*`,
            `📅 Date: ${date}`,
            `🔒 Closure Status: ${closureStatusLabel}`,
            `──────────────────────`,
            `💰 *Collections & Sales:*`,
            `• Net Sales: ₹${(totalRevenuePaise / 100).toFixed(2)}`,
            `• Gross Sales: ₹${(grossSalesPaise / 100).toFixed(2)}`,
            `• Discounts: ₹${(discountPaise / 100).toFixed(2)}`,
            ``,
            `💳 *Payment Modes:*`,
            `• Cash: ₹${(cashPaise / 100).toFixed(2)}`,
            `• UPI: ₹${(upiPaise / 100).toFixed(2)}`,
            `• Card: ₹${(cardPaise / 100).toFixed(2)}`,
            `• Wallet: ₹${(walletPaise / 100).toFixed(2)}`,
            ``,
            `🧾 *Activity Summary:*`,
            `• Invoices Raised: ${billCount}`,
            `• Completed Appointments: ${completedAppts}`,
            `• Cancelled / No-shows: ${cancelledAppts}`,
            ``,
            `💵 *Cash Drawer (Till):*`,
            `• Expected Cash: ₹${(expectedCashPaise / 100).toFixed(2)}`,
            closure ? `• Counted Cash: ₹${(countedCashPaise / 100).toFixed(2)}` : `• Counted Cash: Not closed`,
            `• Till Difference: ₹${(diffCashPaise / 100).toFixed(2)}`,
            `• Till Expenses: ₹${(totalExpensePaise / 100).toFixed(2)}`,
            `──────────────────────`,
            s3Key ? `📄 PDF Report: https://storage.glox.io/${s3Key}` : ``,
          ]
            .filter(Boolean)
            .join('\n');

          const dedupeId = `dayend_report:${branch._id}:${date}`;
          const existingSend = await AutomationSend.findById(dedupeId);
          if (existingSend) {
            continue;
          }

          const msg = await WaMessage.create({
            businessId: bId,
            conversationId: conversation._id,
            direction: 'out',
            // With an approved 'day_end_report' template it goes as that template; without one, as
            // plain text (as before), which WhatsApp accepts inside the owner's 24-hour window
            kind: dayEndTpl ? 'template' : 'text',
            templateId: dayEndTpl?._id,
            variables: dayEndTpl ? [
              branch.name,
              date,
              closureStatusLabel,
              (totalRevenuePaise / 100).toFixed(2),
              (cashPaise / 100).toFixed(2),
              (upiPaise / 100).toFixed(2),
              String(billCount),
            ] : undefined,
            text: reportText,
            mediaKey: s3Key,
            origin: 'transactional',
            status: 'queued',
          });

          await AutomationSend.findOneAndUpdate(
            { _id: dedupeId },
            { businessId: bId, messageId: msg._id, at: new Date() },
            { upsert: true }
          );

          await whatsappSendQueue().add(
            'send',
            { messageId: msg._id.toString() },
            { jobId: msg._id.toString() }
          );
        }
      }
    },
    { connection: connection as any, concurrency: 2 }
  );
}

/** Bill statuses whose sales stay on their day (refunds are counted separately, on the refund day). */
const SOLD_BILL_STATUSES = ['paid', 'partly_paid', 'refunded', 'partly_refunded'];

/**
 * Rebuilds one branch-day summary from the source records, the same way billing keeps it up to
 * date live: sales and tips from that day's bills (refunded bills stay in sales), collections from
 * their payments plus due receipts, refunds by the day they were paid out, bill counts. Only these
 * fields are replaced; anything else in the summary is left as it is.
 */
async function rebuildDailySummaryForBranch(branch: any, date: string): Promise<void> {
  const businessId = branch.businessId;
  const branchId = branch._id;
  const bills = await Bill.find({ businessId, branchId, businessDate: date, status: { $in: SOLD_BILL_STATUSES } });
  const cancelled = await Bill.countDocuments({ businessId, branchId, businessDate: date, status: 'cancelled' });
  const receipts = await DueReceipt.find({ businessId, branchId, businessDate: date, status: { $ne: 'cancelled' } });
  const refundedBills = await Bill.find({ businessId, branchId, 'refunds.businessDate': date }).select('refunds');

  const sales = { grossPaise: 0, discountPaise: 0, netPaise: 0, taxPaise: 0, servicesPaise: 0, productsPaise: 0, plansPaise: 0 };
  const collections: Record<string, number> = { cash: 0, upi: 0, card: 0, wallet: 0 };
  let tipsPaise = 0;

  for (const bill of bills) {
    sales.grossPaise += bill.totals?.grossPaise || 0;
    sales.discountPaise += bill.totals?.discountPaise || 0;
    sales.netPaise += bill.totals?.taxablePaise || 0;
    sales.taxPaise += (bill.totals?.cgstPaise || 0) + (bill.totals?.sgstPaise || 0);
    for (const line of bill.lines || []) {
      if (line.kind === 'service') sales.servicesPaise += line.totalPaise;
      else if (line.kind === 'product') sales.productsPaise += line.totalPaise;
      else sales.plansPaise += line.totalPaise; // membership, package, voucher, wallet top-up (as billing does)
    }
    for (const p of bill.payments || []) collections[p.mode] = (collections[p.mode] || 0) + p.amountPaise;
    tipsPaise += (bill.tips || []).reduce((sum: number, t: any) => sum + (t.amountPaise || 0), 0);
  }
  for (const r of receipts) {
    for (const p of r.payments || []) collections[p.mode] = (collections[p.mode] || 0) + p.amountPaise;
  }
  const refundsPaise = refundedBills.reduce(
    (sum, b: any) =>
      sum + (b.refunds || []).filter((r: any) => r.businessDate === date).reduce((a: number, r: any) => a + r.amountPaise, 0),
    0
  );

  const set: Record<string, unknown> = {
    sales,
    tipsPaise,
    refundsPaise,
    'counts.bills': bills.length,
    'counts.cancelled': cancelled,
    updatedAt: new Date(),
  };
  for (const [mode, amount] of Object.entries(collections)) set[`collections.${mode}`] = amount;

  const summaryId = `${branchId.toString()}:${date}`;
  await DailySummary.findOneAndUpdate(
    { _id: summaryId, businessId },
    { $setOnInsert: { businessId, branchId, businessDate: date }, $set: set },
    { upsert: true }
  );
}

export function createDailySummaryWorker(): Worker {
  const connection = getBullConnection();

  return new Worker(
    'daily-summary',
    async (job: Job<{ branchId?: string; date?: string }>) => {
      const { branchId, date: requestedDate } = job.data || {};
      const date = requestedDate || addDays(getBusinessDate(), -1);
      logger.info({ branchId, date }, 'Recomputing daily-summary job');

      if (branchId) {
        const brId = toObjectId(branchId);
        const branch = await Branch.findById(brId).setOptions({ skipTenantScope: true });
        if (!branch) return;
        await rebuildDailySummaryForBranch(branch, date);
        return;
      }

      const branches = await Branch.find({ status: 'active' }).setOptions({ skipTenantScope: true });
      for (const branch of branches) {
        await rebuildDailySummaryForBranch(branch, date);
      }
    },
    { connection: connection as any, concurrency: 3 }
  );
}
