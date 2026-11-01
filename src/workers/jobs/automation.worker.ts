import { Worker, Job } from 'bullmq';
import { getBullConnection } from '../../integrations';
import {
  Business,
  Appointment,
  Customer,
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
    async (job: Job<{ businessId?: string; slot?: string }>) => {
      const { businessId, slot } = job.data || {};
      logger.info({ businessId, slot }, 'Running automation-scan job');

      const businesses = businessId
        ? await Business.find({ _id: toObjectId(businessId), status: 'active' })
        : await Business.find({ status: 'active' });

      for (const business of businesses) {
        const bId = business._id;
        const waNumber = await WaNumber.findOne({ businessId: bId, status: 'active' });
        if (!waNumber) continue;

        const now = new Date();
        const currentHour = now.getHours();
        // Quiet hours check for marketing (allowed 09:00 - 21:00)
        const isQuietHours = currentHour < 9 || currentHour >= 21;

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
          const cust = await Customer.findById(appt.customerId);
          if (!cust || !cust.phone || cust.doNotMessage || cust.waOptIn === false) continue;

          const is24h = appt.start >= target24hStart && appt.start <= target24hEnd;
          const type = is24h ? 'reminder_24h' : 'reminder_2h';
          const dedupeId = `${type}:${appt._id}:${appt.businessDate}`;

          // Check dedupe
          const existing = await AutomationSend.findById(dedupeId);
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

        // 2. Birthday & Anniversary Wishes (Only outside quiet hours)
        if (!isQuietHours) {
          const todayMonth = String(now.getMonth() + 1).padStart(2, '0');
          const todayDay = String(now.getDate()).padStart(2, '0');
          const todayPattern = `-${todayMonth}-${todayDay}`;
          const todayDateStr = `${now.getFullYear()}-${todayMonth}-${todayDay}`;

          const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          const tomorrowMonth = String(tomorrow.getMonth() + 1).padStart(2, '0');
          const tomorrowDay = String(tomorrow.getDate()).padStart(2, '0');
          const tomorrowPattern = `-${tomorrowMonth}-${tomorrowDay}`;
          const tomorrowDateStr = `${tomorrow.getFullYear()}-${tomorrowMonth}-${tomorrowDay}`;

          // A. Birthday - 1 Day Before
          const birthdayEveCustomers = await Customer.find({
            businessId: bId,
            doNotMessage: { $ne: true },
            waOptIn: { $ne: false },
            dob: { $regex: `${tomorrowPattern}$` },
          }).limit(200);

          for (const cust of birthdayEveCustomers) {
            if (!cust.phone) continue;
            const dedupeId = `birthday_prev:${cust._id}:${tomorrowDateStr}`;
            const existing = await AutomationSend.findById(dedupeId);
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

            const wishText = `Hi ${cust.name}, your birthday is tomorrow! 🎂 The team at ${business.name} wishes you an early Happy Birthday. We'd love to pamper you on your special day — book your celebration appointment with us!`;

            const msg = await WaMessage.create({
              businessId: bId,
              conversationId: conversation._id,
              direction: 'out',
              kind: 'text',
              text: wishText,
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

          // B. Birthday - On the Day
          const birthdayCustomers = await Customer.find({
            businessId: bId,
            doNotMessage: { $ne: true },
            waOptIn: { $ne: false },
            dob: { $regex: `${todayPattern}$` },
          }).limit(200);

          for (const cust of birthdayCustomers) {
            if (!cust.phone) continue;
            const dedupeId = `birthday_today:${cust._id}:${todayDateStr}`;
            const existing = await AutomationSend.findById(dedupeId);
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

            const wishText = `Happy Birthday ${cust.name}! 🎉 Wishing you a year ahead filled with happiness, health, and glowing beauty. Warm wishes from all of us at ${business.name}!`;

            const msg = await WaMessage.create({
              businessId: bId,
              conversationId: conversation._id,
              direction: 'out',
              kind: 'text',
              text: wishText,
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

          // C. Anniversary - 1 Day Before
          const anniversaryEveCustomers = await Customer.find({
            businessId: bId,
            doNotMessage: { $ne: true },
            waOptIn: { $ne: false },
            anniversary: { $regex: `${tomorrowPattern}$` },
          }).limit(200);

          for (const cust of anniversaryEveCustomers) {
            if (!cust.phone) continue;
            const dedupeId = `anniversary_prev:${cust._id}:${tomorrowDateStr}`;
            const existing = await AutomationSend.findById(dedupeId);
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

            const wishText = `Hi ${cust.name}, your anniversary is tomorrow! 🥂 Wishing you an early Happy Anniversary from ${business.name}. Celebrate your special milestone with us!`;

            const msg = await WaMessage.create({
              businessId: bId,
              conversationId: conversation._id,
              direction: 'out',
              kind: 'text',
              text: wishText,
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

          // D. Anniversary - On the Day
          const anniversaryCustomers = await Customer.find({
            businessId: bId,
            doNotMessage: { $ne: true },
            waOptIn: { $ne: false },
            anniversary: { $regex: `${todayPattern}$` },
          }).limit(200);

          for (const cust of anniversaryCustomers) {
            if (!cust.phone) continue;
            const dedupeId = `anniversary_today:${cust._id}:${todayDateStr}`;
            const existing = await AutomationSend.findById(dedupeId);
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

            const wishText = `Happy Anniversary ${cust.name}! 💐 Wishing you a wonderful celebration filled with love, laughter, and joy. Warm wishes from all of us at ${business.name}!`;

            const msg = await WaMessage.create({
              businessId: bId,
              conversationId: conversation._id,
              direction: 'out',
              kind: 'text',
              text: wishText,
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
