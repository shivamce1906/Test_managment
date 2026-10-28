import { Worker, Job } from 'bullmq';
import { getBullConnection } from '../../integrations';
import {
  Business,
  Appointment,
  Customer,
  Automation,
  AutomationSend,
  WaConversation,
  WaMessage,
  WaNumber,
} from '../../models';
import { logger } from '../../utils';
import { toObjectId } from '../../services';
import { whatsappSendQueue } from '../queues';

export function createAutomationWorker(): Worker {
  const connection = getBullConnection();

  return new Worker(
    'automation-scan',
    async (job: Job<{ businessId: string; slot: string }>) => {
      const { businessId, slot } = job.data;
      const bId = toObjectId(businessId);
      logger.info({ businessId, slot }, 'Running automation-scan job');

      const business = await Business.findById(bId);
      if (!business || business.status !== 'active') return;

      const waNumber = await WaNumber.findOne({ businessId: bId, status: 'active' });
      if (!waNumber) return;

      const now = new Date();
      // Quiet hours check for marketing (allowed 09:00 - 21:00 IST)
      const istTime = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
      const istHour = istTime.getUTCHours();
      const isQuietHours = istHour < 9 || istHour >= 21;

      // 1. 24h & 2h Appointment Reminders
      const target24hStart = new Date(now.getTime() + 23.5 * 60 * 60 * 1000);
      const target24hEnd = new Date(now.getTime() + 24.5 * 60 * 60 * 1000);
      const target2hStart = new Date(now.getTime() + 1.5 * 60 * 60 * 1000);
      const target2hEnd = new Date(now.getTime() + 2.5 * 60 * 60 * 1000);

      const upcomingAppts = await Appointment.find({
        businessId: bId,
        status: { $in: ['confirmed', 'booked'] },
        $or: [
          { start: { $gte: target24hStart, $lte: target24hEnd } },
          { start: { $gte: target2hStart, $lte: target2hEnd } },
        ],
      });

      for (const appt of upcomingAppts) {
        const is24h = appt.start >= target24hStart && appt.start <= target24hEnd;
        const type = is24h ? 'reminder_24h' : 'reminder_2h';

        const autoConfig = await Automation.findOne({ businessId: bId, key: type });
        if (!autoConfig || !autoConfig.enabled) {
          continue;
        }

        const cust = await Customer.findOne({ _id: appt.customerId, businessId: bId });
        if (!cust || !cust.phone || cust.doNotMessage) continue;

        const dedupeId = `${type}:${appt._id}:${appt.businessDate}`;

        // Check dedupe
        const existing = await AutomationSend.findOne({ _id: dedupeId });
        if (existing) continue;

        // Ensure conversation exists
        let conversation = await WaConversation.findOne({
          businessId: bId,
          numberId: waNumber._id,
          phone: cust.phone,
        });

        if (!conversation) {
          conversation = await WaConversation.create({
            businessId: bId,
            numberId: waNumber._id,
            branchId: appt.branchId,
            phone: cust.phone,
            customerId: cust._id,
            lastMessageAt: new Date(),
            unread: 0,
          });
        }

        const msg = await WaMessage.create({
          businessId: bId,
          conversationId: conversation._id,
          direction: 'out',
          kind: 'template',
          variables: [cust.name, appt.start.toLocaleTimeString()],
          origin: 'automation',
          originId: appt._id,
          status: 'queued',
        });

        await AutomationSend.create({
          _id: dedupeId,
          businessId: bId,
          messageId: msg._id,
          at: new Date(),
        });

        await whatsappSendQueue().add(
          'send',
          { messageId: msg._id.toString() },
          { jobId: msg._id.toString() }
        );
      }

      // 2. Birthday wishes (Only outside quiet hours)
      if (!isQuietHours) {
        const autoBirthday = await Automation.findOne({ businessId: bId, key: 'birthday' });
        if (autoBirthday && autoBirthday.enabled) {
          const todayMonth = String(istTime.getUTCMonth() + 1).padStart(2, '0');
          const todayDay = String(istTime.getUTCDate()).padStart(2, '0');
          const birthdayPattern = `-${todayMonth}-${todayDay}`;
          const dateStr = `${istTime.getUTCFullYear()}-${todayMonth}-${todayDay}`;

          const birthdayCustomers = await Customer.find({
            businessId: bId,
            doNotMessage: { $ne: true },
            waOptIn: true,
            dob: { $regex: `${birthdayPattern}$` },
          }).limit(200);

          for (const cust of birthdayCustomers) {
            const dedupeId = `birthday:${cust._id}:${dateStr}`;
            const existing = await AutomationSend.findOne({ _id: dedupeId });
            if (existing) continue;

          let conversation = await WaConversation.findOne({
            businessId: bId,
            numberId: waNumber._id,
            phone: cust.phone,
          });

          if (!conversation) {
            conversation = await WaConversation.create({
              businessId: bId,
              numberId: waNumber._id,
              branchId: waNumber.branchIds[0] || bId,
              phone: cust.phone,
              customerId: cust._id,
              lastMessageAt: new Date(),
              unread: 0,
            });
          }

          const msg = await WaMessage.create({
            businessId: bId,
            conversationId: conversation._id,
            direction: 'out',
            kind: 'template',
            variables: [cust.name],
            origin: 'automation',
            originId: cust._id,
            status: 'queued',
          });

          await AutomationSend.create({
            _id: dedupeId,
            businessId: bId,
            messageId: msg._id,
            at: new Date(),
          });

            await whatsappSendQueue().add(
              'send',
              { messageId: msg._id.toString() },
              { jobId: msg._id.toString() }
            );
          }
        }
      }
    },
    { connection: connection as any, concurrency: 2 }
  );
}
