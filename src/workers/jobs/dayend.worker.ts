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
            kind: 'template',
            templateId: dayEndTpl?._id,
            variables: [
              branch.name,
              date,
              closureStatusLabel,
              (totalRevenuePaise / 100).toFixed(2),
              (cashPaise / 100).toFixed(2),
              (upiPaise / 100).toFixed(2),
              String(billCount),
            ],
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

async function rebuildDailySummaryForBranch(branch: any, date: string): Promise<void> {
  const brId = branch._id;
  const bills = await Bill.find({
    businessId: branch.businessId,
    branchId: brId,
    businessDate: date,
    status: { $in: ['paid', 'partly_paid'] },
  });

  let grossPaise = 0;
  let discountPaise = 0;
  let netPaise = 0;
  let taxPaise = 0;
  let servicesPaise = 0;
  let productsPaise = 0;
  let plansPaise = 0;
  let cash = 0;
  let upi = 0;
  let card = 0;
  let wallet = 0;

  for (const bill of bills) {
    grossPaise += bill.totals?.grossPaise || 0;
    discountPaise += bill.totals?.discountPaise || 0;
    netPaise += bill.totals?.taxablePaise || 0;
    taxPaise += (bill.totals?.cgstPaise || 0) + (bill.totals?.sgstPaise || 0);

    for (const line of bill.lines || []) {
      if (line.kind === 'service') servicesPaise += line.totalPaise;
      else if (line.kind === 'product') productsPaise += line.totalPaise;
      else if (['package', 'membership', 'voucher'].includes(line.kind)) plansPaise += line.totalPaise;
    }

    for (const p of bill.payments || []) {
      if (p.mode === 'cash') cash += p.amountPaise;
      else if (p.mode === 'card') card += p.amountPaise;
      else if (p.mode === 'upi') upi += p.amountPaise;
      else if (p.mode === 'wallet') wallet += p.amountPaise;
    }
  }

  const summaryId = `${brId.toString()}:${date}`;
  await DailySummary.findOneAndUpdate(
    { _id: summaryId, businessId: branch.businessId },
    {
      _id: summaryId,
      businessId: branch.businessId,
      branchId: brId,
      businessDate: date,
      sales: {
        grossPaise,
        discountPaise,
        netPaise,
        taxPaise,
        servicesPaise,
        productsPaise,
        plansPaise,
      },
      collections: {
        cash,
        upi,
        card,
        wallet,
      },
      refundsPaise: 0,
      tipsPaise: 0,
      counts: {
        bills: bills.length,
        cancelled: 0,
        customers: bills.length,
        newCustomers: 0,
        appointments: 0,
        noShows: 0,
      },
      updatedAt: new Date(),
    },
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
