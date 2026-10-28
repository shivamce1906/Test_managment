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
  User,
  DayClosure,
} from '../../models';
import { logger } from '../../utils';
import { toObjectId } from '../../services';
import { whatsappSendQueue } from '../queues';

export function createDayEndWorker(): Worker {
  const connection = getBullConnection();

  return new Worker(
    'day-end-report',
    async (job: Job<{ businessId: string; date: string }>) => {
      const { businessId, date } = job.data;
      const bId = toObjectId(businessId);
      logger.info({ businessId, date }, 'Generating day-end-report job');

      const business = await Business.findById(bId);
      if (!business) return;

      const waNumber = await WaNumber.findOne({ businessId: bId, status: 'active' });

      const branches = await Branch.find({ businessId: bId, status: 'active' });
      for (const branch of branches) {
        const bills = await Bill.find({
          businessId: bId,
          branchId: branch._id,
          businessDate: date,
          status: { $in: ['paid', 'partly_paid'] },
        });

        const totalRevenuePaise = bills.reduce((acc, b) => acc + (b.totals?.totalPaise || 0), 0);
        const billCount = bills.length;

        let expectedCashPaise = 0;
        let upiPaise = 0;
        let cardPaise = 0;
        for (const b of bills) {
          for (const p of b.payments || []) {
            if (p.mode === 'cash') expectedCashPaise += p.amountPaise;
            else if (p.mode === 'upi') upiPaise += p.amountPaise;
            else if (p.mode === 'card') cardPaise += p.amountPaise;
          }
        }

        const dayClosure = await DayClosure.findOne({
          businessId: bId,
          branchId: branch._id,
          businessDate: date,
        });
        const statusStr = dayClosure ? (dayClosure.status === 'approved' ? 'Closed' : dayClosure.status) : 'Not closed';

        const pdfBuffer = await generateDayEndPdf({
          branchName: branch.name,
          businessDate: date,
          expectedCashPaise,
          countedCashPaise: dayClosure?.counted?.cashPaise ?? expectedCashPaise,
          diffCashPaise: dayClosure?.diff?.cashPaise ?? 0,
          upiPaise,
          cardPaise,
        });

        const s3Key = `reports/${bId}/${branch._id}/dayend-${date}.pdf`;
        await s3Adapter.uploadBuffer(s3Key, pdfBuffer, 'application/pdf');

        // Send WhatsApp report to owner if configured
        const ownerPhone = business.ownerWhatsappPhone || (await User.findOne({ businessId: bId, role: 'owner' }))?.phone;
        if (ownerPhone && waNumber) {
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

          const msg = await WaMessage.create({
            businessId: bId,
            conversationId: conversation._id,
            direction: 'out',
            kind: 'template',
            text: `Day-end report for ${branch.name} (${date}): ${statusStr}. Cash: ${(expectedCashPaise / 100).toFixed(2)}, Total: ${(totalRevenuePaise / 100).toFixed(2)}`,
            variables: [branch.name, date, statusStr, (totalRevenuePaise / 100).toFixed(2), String(billCount)],
            mediaKey: s3Key,
            origin: 'transactional',
            status: 'queued',
          });

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

export function createDailySummaryWorker(): Worker {
  const connection = getBullConnection();

  return new Worker(
    'daily-summary',
    async (job: Job<{ branchId: string; date: string }>) => {
      const { branchId, date } = job.data;
      logger.info({ branchId, date }, 'Recomputing daily-summary job');

      const brId = toObjectId(branchId);
      const branch = await Branch.findOne({ _id: brId }, null, { skipTenantScope: true });
      if (!branch) return;

      const bills = await Bill.find(
        {
          branchId: brId,
          businessDate: date,
          status: { $in: ['paid', 'partly_paid'] },
        },
        null,
        { skipTenantScope: true }
      );

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
        { _id: summaryId },
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
        { upsert: true, skipTenantScope: true } as any
      );
    },
    { connection: connection as any, concurrency: 3 }
  );
}
