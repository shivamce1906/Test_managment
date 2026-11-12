import { Worker, Job } from 'bullmq';
import { Types } from 'mongoose';
import { getBullConnection } from '../../integrations';
import {
  Business,
  Appointment,
  Customer,
  CustomerPlan,
  Service,
  Automation,
  AutomationSend,
  WaConversation,
  WaMessage,
  WaNumber,
  WaTemplate,
} from '../../models';
import { logger, getBusinessDate, addDays, formatIstTime } from '../../utils';
import { toObjectId } from '../../services';
import { defaultChatBranchId } from '../../services/whatsapp.service';
import { whatsappSendQueue } from '../queues';

function parseClockMinutes(hhmm: string | undefined, fallback: number): number {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return fallback;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function isQuietHoursIst(guards?: { quietStart?: string; quietEnd?: string }, now: Date = new Date()): boolean {
  const startMin = parseClockMinutes(guards?.quietStart, 21 * 60);
  const endMin = parseClockMinutes(guards?.quietEnd, 9 * 60);
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const curMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (startMin > endMin) {
    return curMin >= startMin || curMin < endMin;
  }
  return curMin >= startMin && curMin < endMin;
}

async function ensureConversation(
  businessId: Types.ObjectId,
  waNumber: any,
  customer: any,
  branchId?: Types.ObjectId
) {
  let conversation = await WaConversation.findOne({
    businessId,
    numberId: waNumber._id,
    phone: customer.phone,
  });
  if (!conversation) {
    const resolvedBranchId = branchId || (await defaultChatBranchId(businessId, waNumber));
    conversation = await WaConversation.create({
      businessId,
      numberId: waNumber._id,
      branchId: resolvedBranchId,
      phone: customer.phone,
      customerId: customer._id,
      lastMessageAt: new Date(),
      unread: 0,
    });
  }
  return conversation;
}

async function canSendMarketingToday(
  businessId: Types.ObjectId,
  customerId: Types.ObjectId,
  todayDateStr: string,
  maxMarketingPerDay: number
): Promise<boolean> {
  if (maxMarketingPerDay <= 0) return false;
  const count = await AutomationSend.countDocuments({
    businessId,
    _id: { $regex: `^mktcap:${customerId}:${todayDateStr}:` },
  });
  return count < maxMarketingPerDay;
}

async function queueAutomationMessage(params: {
  businessId: Types.ObjectId;
  waNumber: any;
  customer: any;
  branchId?: Types.ObjectId;
  dedupeId: string;
  originId: Types.ObjectId;
  templateId?: Types.ObjectId;
  fallbackTemplateName?: string;
  variables?: string[];
  text?: string;
  isMarketing: boolean;
  todayDateStr: string;
  maxMarketingPerDay: number;
}): Promise<boolean> {
  const {
    businessId,
    waNumber,
    customer,
    branchId,
    dedupeId,
    originId,
    templateId,
    fallbackTemplateName,
    variables,
    text,
    isMarketing,
    todayDateStr,
    maxMarketingPerDay,
  } = params;

  if (!customer || !customer.phone || customer.doNotMessage || customer.waOptIn === false) {
    return false;
  }
  if (await AutomationSend.findById(dedupeId)) {
    return false;
  }
  if (isMarketing && !(await canSendMarketingToday(businessId, customer._id, todayDateStr, maxMarketingPerDay))) {
    return false;
  }

  let resolvedTplId: Types.ObjectId | undefined;
  if (templateId) {
    const tpl = await WaTemplate.findOne({ _id: templateId, businessId, status: 'approved' });
    if (tpl) resolvedTplId = tpl._id;
  } else if (fallbackTemplateName) {
    const tpl = await WaTemplate.findOne({ businessId, name: fallbackTemplateName, status: 'approved' });
    if (tpl) resolvedTplId = tpl._id;
  }

  const conversation = await ensureConversation(businessId, waNumber, customer, branchId);

  const msg = await WaMessage.create({
    businessId,
    conversationId: conversation._id,
    direction: 'out',
    kind: resolvedTplId || !text ? 'template' : 'text',
    templateId: resolvedTplId,
    variables: resolvedTplId || !text ? variables : undefined,
    text,
    origin: 'automation',
    originId,
    status: 'queued',
  });

  await AutomationSend.create({
    _id: dedupeId,
    businessId,
    messageId: msg._id,
    at: new Date(),
  });

  if (isMarketing) {
    await AutomationSend.create({
      _id: `mktcap:${customer._id}:${todayDateStr}:${msg._id}`,
      businessId,
      messageId: msg._id,
      at: new Date(),
    });
  }

  await whatsappSendQueue().add(
    'send',
    { messageId: msg._id.toString() },
    { jobId: msg._id.toString() }
  );
  return true;
}

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
        const todayDateStr = getBusinessDate(now);
        const tomorrowDateStr = addDays(todayDateStr, 1);
        const maxMarketingPerDay = business.automationGuards?.maxMarketingPerDay ?? 1;
        const isQuietHours = isQuietHoursIst(business.automationGuards, now);

        const automations = await Automation.find({ businessId: bId });
        const autoByKey = new Map(automations.map((a) => [a.key, a]));

        // 1. 24h & 2h Appointment Reminders (transactional: honor each Automation.enabled flag)
        const rem24Auto = autoByKey.get('reminder_24h');
        const rem2Auto = autoByKey.get('reminder_2h');

        if (rem24Auto?.enabled || rem2Auto?.enabled) {
          const target24hStart = new Date(now.getTime() + 23.5 * 60 * 60 * 1000);
          const target24hEnd = new Date(now.getTime() + 24.5 * 60 * 60 * 1000);
          const target2hStart = new Date(now.getTime() + 1.5 * 60 * 60 * 1000);
          const target2hEnd = new Date(now.getTime() + 2.5 * 60 * 60 * 1000);

          const orClauses: any[] = [];
          if (rem24Auto?.enabled) orClauses.push({ start: { $gte: target24hStart, $lte: target24hEnd } });
          if (rem2Auto?.enabled) orClauses.push({ start: { $gte: target2hStart, $lte: target2hEnd } });

          const upcomingAppts = await Appointment.find({
            businessId: bId,
            status: { $in: ['confirmed', 'booked'] },
            $or: orClauses,
          });

          for (const appt of upcomingAppts) {
            const is24h = appt.start >= target24hStart && appt.start <= target24hEnd;
            const autoCfg = is24h ? rem24Auto : rem2Auto;
            if (!autoCfg?.enabled) continue;

            const type = is24h ? 'reminder_24h' : 'reminder_2h';
            const cust = await Customer.findOne({ _id: appt.customerId, businessId: bId });
            if (!cust) continue;

            await queueAutomationMessage({
              businessId: bId,
              waNumber,
              customer: cust,
              branchId: appt.branchId,
              dedupeId: `${type}:${appt._id}:${appt.businessDate}`,
              originId: appt._id,
              templateId: autoCfg.templateId,
              variables: [cust.name, formatIstTime(appt.start)],
              isMarketing: false,
              todayDateStr,
              maxMarketingPerDay,
            });
          }
        }

        // Marketing automations stop during quiet hours (IST)
        if (isQuietHours) continue;

        const todayPattern = todayDateStr.slice(4); // -MM-DD
        const tomorrowPattern = tomorrowDateStr.slice(4);

        // 2. Birthday Wishes (1 day before & on the day)
        const birthdayAuto = autoByKey.get('birthday');
        if (birthdayAuto?.enabled) {
          const birthdayEveCustomers = await Customer.find({
            businessId: bId,
            doNotMessage: { $ne: true },
            waOptIn: { $ne: false },
            dob: { $regex: `${tomorrowPattern}$` },
          }).limit(200);

          for (const cust of birthdayEveCustomers) {
            const wishText = `Hi ${cust.name}, your birthday is tomorrow! 🎂 The team at ${business.name} wishes you an early Happy Birthday. We'd love to pamper you on your special day — book your celebration appointment with us!`;
            await queueAutomationMessage({
              businessId: bId,
              waNumber,
              customer: cust,
              dedupeId: `birthday_prev:${cust._id}:${tomorrowDateStr}`,
              originId: cust._id,
              templateId: birthdayAuto.templateId,
              fallbackTemplateName: 'birthday_offer',
              variables: [cust.name, business.name, 'BDAY'],
              text: wishText,
              isMarketing: true,
              todayDateStr,
              maxMarketingPerDay,
            });
          }

          const birthdayCustomers = await Customer.find({
            businessId: bId,
            doNotMessage: { $ne: true },
            waOptIn: { $ne: false },
            dob: { $regex: `${todayPattern}$` },
          }).limit(200);

          for (const cust of birthdayCustomers) {
            const wishText = `Happy Birthday ${cust.name}! 🎉 Wishing you a year ahead filled with happiness, health, and glowing beauty. Warm wishes from all of us at ${business.name}!`;
            await queueAutomationMessage({
              businessId: bId,
              waNumber,
              customer: cust,
              dedupeId: `birthday_today:${cust._id}:${todayDateStr}`,
              originId: cust._id,
              templateId: birthdayAuto.templateId,
              fallbackTemplateName: 'birthday_offer',
              variables: [cust.name, business.name, 'BDAY'],
              text: wishText,
              isMarketing: true,
              todayDateStr,
              maxMarketingPerDay,
            });
          }
        }

        // 3. Anniversary Wishes (1 day before & on the day)
        const anniversaryAuto = autoByKey.get('anniversary');
        if (anniversaryAuto?.enabled) {
          const anniversaryEveCustomers = await Customer.find({
            businessId: bId,
            doNotMessage: { $ne: true },
            waOptIn: { $ne: false },
            anniversary: { $regex: `${tomorrowPattern}$` },
          }).limit(200);

          for (const cust of anniversaryEveCustomers) {
            const wishText = `Hi ${cust.name}, your anniversary is tomorrow! 🥂 Wishing you an early Happy Anniversary from ${business.name}. Celebrate your special milestone with us!`;
            await queueAutomationMessage({
              businessId: bId,
              waNumber,
              customer: cust,
              dedupeId: `anniversary_prev:${cust._id}:${tomorrowDateStr}`,
              originId: cust._id,
              templateId: anniversaryAuto.templateId,
              variables: [cust.name, business.name],
              text: wishText,
              isMarketing: true,
              todayDateStr,
              maxMarketingPerDay,
            });
          }

          const anniversaryCustomers = await Customer.find({
            businessId: bId,
            doNotMessage: { $ne: true },
            waOptIn: { $ne: false },
            anniversary: { $regex: `${todayPattern}$` },
          }).limit(200);

          for (const cust of anniversaryCustomers) {
            const wishText = `Happy Anniversary ${cust.name}! 💐 Wishing you a wonderful celebration filled with love, laughter, and joy. Warm wishes from all of us at ${business.name}!`;
            await queueAutomationMessage({
              businessId: bId,
              waNumber,
              customer: cust,
              dedupeId: `anniversary_today:${cust._id}:${todayDateStr}`,
              originId: cust._id,
              templateId: anniversaryAuto.templateId,
              variables: [cust.name, business.name],
              text: wishText,
              isMarketing: true,
              todayDateStr,
              maxMarketingPerDay,
            });
          }
        }

        // 4. Rebooking Reminders (based on service.rebookDays)
        const rebookingAuto = autoByKey.get('rebooking');
        if (rebookingAuto?.enabled) {
          const rebookServices = await Service.find({
            businessId: bId,
            active: true,
            rebookDays: { $gt: 0 },
          }).limit(100);

          for (const svc of rebookServices) {
            const targetDate = addDays(todayDateStr, -svc.rebookDays!);
            const windowStart = addDays(targetDate, -2);
            const pastAppts = await Appointment.find({
              businessId: bId,
              status: { $in: ['completed', 'billed'] },
              businessDate: { $gte: windowStart, $lte: targetDate },
              'lines.serviceId': svc._id,
            }).limit(200);

            for (const appt of pastAppts) {
              const hasNewer = await Appointment.exists({
                businessId: bId,
                customerId: appt.customerId,
                businessDate: { $gt: appt.businessDate },
                status: { $in: ['booked', 'confirmed', 'arrived', 'in_service', 'completed', 'billed'] },
              });
              if (hasNewer) continue;

              const cust = await Customer.findOne({ _id: appt.customerId, businessId: bId });
              if (!cust) continue;

              const nudgeText = `Hi ${cust.name}, it has been ${svc.rebookDays} days since your ${svc.name} at ${business.name}. Ready for your next visit? Reply to book your slot!`;
              await queueAutomationMessage({
                businessId: bId,
                waNumber,
                customer: cust,
                branchId: appt.branchId,
                dedupeId: `rebooking:${cust._id}:${svc._id}:${todayDateStr.slice(0, 7)}`,
                originId: appt._id,
                templateId: rebookingAuto.templateId,
                fallbackTemplateName: 'rebooking_nudge',
                variables: [cust.name, svc.name, business.name, ''],
                text: nudgeText,
                isMarketing: true,
                todayDateStr,
                maxMarketingPerDay,
              });
            }
          }
        }

        // 5. Winback Inactive Customers
        const winbackAuto = autoByKey.get('winback');
        if (winbackAuto?.enabled) {
          const inactiveDays = Number(winbackAuto.settings?.inactiveDays) || 60;
          const cutoffDate = addDays(todayDateStr, -inactiveDays);
          const inactiveCustomers = await Customer.find({
            businessId: bId,
            doNotMessage: { $ne: true },
            waOptIn: { $ne: false },
            'stats.lastVisit': { $lte: cutoffDate },
          }).limit(200);

          for (const cust of inactiveCustomers) {
            const text = `Hi ${cust.name}, we miss seeing you at ${business.name}! Come back and pamper yourself — reply anytime to book an appointment.`;
            await queueAutomationMessage({
              businessId: bId,
              waNumber,
              customer: cust,
              dedupeId: `winback:${cust._id}:${todayDateStr.slice(0, 7)}`,
              originId: cust._id,
              templateId: winbackAuto.templateId,
              variables: [cust.name, business.name],
              text,
              isMarketing: true,
              todayDateStr,
              maxMarketingPerDay,
            });
          }
        }

        // 6. Membership Expiry Alerts
        const membershipAuto = autoByKey.get('membership_expiry');
        if (membershipAuto?.enabled) {
          const daysBefore = Number(membershipAuto.settings?.daysBefore) || 7;
          const expiryUpperBound = addDays(todayDateStr, daysBefore);
          const expiringMemberships = await CustomerPlan.find({
            businessId: bId,
            status: 'active',
            'planSnap.type': 'membership',
            validTill: { $gte: todayDateStr, $lte: expiryUpperBound },
          }).limit(200);

          for (const plan of expiringMemberships) {
            const cust = await Customer.findOne({ _id: plan.customerId, businessId: bId });
            if (!cust) continue;

            const text = `Hi ${cust.name}, your ${plan.planSnap?.name || 'membership'} at ${business.name} expires on ${plan.validTill}. Renew today to continue enjoying your benefits!`;
            await queueAutomationMessage({
              businessId: bId,
              waNumber,
              customer: cust,
              branchId: plan.soldBranchId,
              dedupeId: `membership_expiry:${plan._id}:${todayDateStr.slice(0, 7)}`,
              originId: plan._id,
              templateId: membershipAuto.templateId,
              variables: [cust.name, plan.planSnap?.name || 'Membership', plan.validTill],
              text,
              isMarketing: false, // service notice: not counted against the daily marketing cap
              todayDateStr,
              maxMarketingPerDay,
            });
          }
        }

        // 7. Package Last Session Reminder
        const packageLastAuto = autoByKey.get('package_last_session');
        if (packageLastAuto?.enabled) {
          const activePackages = await CustomerPlan.find({
            businessId: bId,
            status: 'active',
            'planSnap.type': 'package',
          }).limit(200);

          for (const plan of activePackages) {
            const lastSessionEntry = (plan.sessions || []).find((s) => s.total - s.used === 1);
            if (!lastSessionEntry) continue;

            const cust = await Customer.findOne({ _id: plan.customerId, businessId: bId });
            if (!cust) continue;

            const text = `Hi ${cust.name}, you have 1 session remaining in your ${plan.planSnap?.name || 'package'} at ${business.name} (valid till ${plan.validTill}). Book now before it expires!`;
            await queueAutomationMessage({
              businessId: bId,
              waNumber,
              customer: cust,
              branchId: plan.soldBranchId,
              dedupeId: `package_last_session:${plan._id}:${lastSessionEntry.serviceId}`,
              originId: plan._id,
              templateId: packageLastAuto.templateId,
              variables: [cust.name, plan.planSnap?.name || 'Package', plan.validTill],
              text,
              isMarketing: false, // service notice: not counted against the daily marketing cap
              todayDateStr,
              maxMarketingPerDay,
            });
          }
        }
      }
    },
    { connection: connection as any, concurrency: 2 }
  );
}
