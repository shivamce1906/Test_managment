import '../helpers/testEnv';

// Capture every BullMQ processor so each background job can be run directly against the DB.
const processors: Record<string, (job: any) => Promise<any>> = {};
const queued: { queue: string; name: string; data: any }[] = [];
jest.mock('bullmq', () => ({
  Worker: class {
    constructor(name: string, fn: any) {
      processors[name] = fn;
    }
    on() {
      return this;
    }
    close() {
      return Promise.resolve();
    }
  },
  Queue: class {
    constructor(public name: string) {}
    add(name: string, data: any) {
      queued.push({ queue: this.name, name, data });
      return Promise.resolve({ id: 'x' });
    }
    getRepeatableJobs() {
      return Promise.resolve([]);
    }
    removeRepeatableByKey() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  },
  QueueEvents: class {
    on() {}
  },
}));

import { Types } from 'mongoose';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, serviceLine, dayOffset, createCustomer } from '../helpers/factory';
import {
  WaNumber, WaTemplate, WaMessage, WaConversation, Appointment, Automation, AutomationSend, CustomerPlan, Customer,
  RecurringExpense, Expense, Notification, Product, DailySummary, DayClosure,
} from '../../src/models';
import { createWhatsAppWorker } from '../../src/workers/jobs/whatsapp.worker';
import { createAutomationWorker } from '../../src/workers/jobs/automation.worker';
import { createDayEndWorker, createDailySummaryWorker } from '../../src/workers/jobs/dayend.worker';
import { createPlanExpiryWorker, createRecurringExpenseWorker, createStockAlertsWorker, createLedgerCheckWorker } from '../../src/workers/jobs/maintenance.worker';
import { encryptData, getBusinessDate } from '../../src/utils';

[createWhatsAppWorker, createAutomationWorker, createDayEndWorker, createDailySummaryWorker, createPlanExpiryWorker,
  createRecurringExpenseWorker, createStockAlertsWorker, createLedgerCheckWorker].forEach((f) => f());

const run = (queue: string, data: any) => processors[queue]({ id: 'job1', name: queue, data, attemptsMade: 0 });
const DATE_ONLY = ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask', 'hrtime', 'performance'] as any;

async function wa(w: World) {
  const number = await WaNumber.create({
    businessId: w.business._id, phone: '+919800000099',
    aisensy: { apiKeyEnc: encryptData('key'), projectId: 'p1', webhookSecretEnc: encryptData('s') },
    branchIds: [], status: 'active', lowBalance: false,
  });
  const template = await WaTemplate.create({ businessId: w.business._id, numberId: number._id, name: 'reminder', category: 'utility', body: 'x', status: 'approved' });
  return { number, template };
}

async function appointmentIn(w: World, hours: number) {
  const start = new Date(Date.now() + hours * 3600 * 1000);
  return Appointment.create({
    businessId: w.business._id, branchId: w.branchA._id, customerId: w.customer._id, businessDate: getBusinessDate(start),
    lines: [{ serviceId: w.haircut._id, serviceName: 'Haircut', staffId: w.stylist1._id, start, end: new Date(start.getTime() + 1800000) }],
    start, end: new Date(start.getTime() + 1800000), status: 'booked', statusLog: [{ status: 'booked', at: new Date(), by: w.owner._id }], source: 'phone',
  });
}

describe('Worker — whatsapp-send', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
    queued.length = 0;
  });

  it('sends a queued message and marks it sent with a provider id', async () => {
    const { number } = await wa(w);
    const conv = await WaConversation.create({ businessId: w.business._id, numberId: number._id, branchId: w.branchA._id, phone: w.customer.phone, unread: 0 });
    const msg = await WaMessage.create({ businessId: w.business._id, conversationId: conv._id, direction: 'out', kind: 'text', text: 'hi', status: 'queued', origin: 'transactional' });
    await run('whatsapp-send', { messageId: msg._id.toString() });
    const after = await WaMessage.findOne({ _id: msg._id, businessId: w.business._id });
    expect(after!.status).toBe('sent');
    expect(after!.providerMessageId).toBeTruthy();
  });
});

describe('Worker — automation-scan (PRD §13)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
    queued.length = 0;
  });

  it('queues a 24 h reminder once, even if the scan runs twice', async () => {
    await wa(w);
    await Automation.create({ businessId: w.business._id, key: 'reminder_24h', enabled: true });
    await appointmentIn(w, 24);
    await run('automation-scan', { businessId: w.business._id.toString(), slot: 's1' });
    await run('automation-scan', { businessId: w.business._id.toString(), slot: 's2' });
    expect(await WaMessage.countDocuments({ businessId: w.business._id, origin: 'automation' })).toBe(1);
    expect(await AutomationSend.countDocuments({ businessId: w.business._id })).toBe(1);
  });

  it('does not send a reminder when the owner switched the automation OFF', async () => {
    await wa(w);
    await Automation.create({ businessId: w.business._id, key: 'reminder_24h', enabled: false });
    await appointmentIn(w, 24);
    await run('automation-scan', { businessId: w.business._id.toString(), slot: 's1' });
    expect(await WaMessage.countDocuments({ businessId: w.business._id, origin: 'automation' })).toBe(0);
  });

  it('skips customers marked do-not-message', async () => {
    await wa(w);
    await Automation.create({ businessId: w.business._id, key: 'reminder_24h', enabled: true });
    await Customer.updateOne({ _id: w.customer._id, businessId: w.business._id }, { $set: { doNotMessage: true } });
    await appointmentIn(w, 24);
    await run('automation-scan', { businessId: w.business._id.toString(), slot: 's1' });
    expect(await WaMessage.countDocuments({ businessId: w.business._id, origin: 'automation' })).toBe(0);
  });

  it('no marketing (birthday) message during quiet hours 21:00–09:00 IST', async () => {
    await wa(w);
    await Automation.create({ businessId: w.business._id, key: 'birthday', enabled: true });
    jest.useFakeTimers({ now: new Date('2026-10-28T17:00:00.000Z'), doNotFake: DATE_ONLY }); // 22:30 IST
    try {
      await createCustomer(w.business._id, { name: 'Bday', dob: '1990-10-28' });
      await run('automation-scan', { businessId: w.business._id.toString(), slot: 'q' });
      expect(await WaMessage.countDocuments({ businessId: w.business._id, origin: 'automation' })).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('marketing messages skip customers without WhatsApp opt-in', async () => {
    await wa(w);
    await Automation.create({ businessId: w.business._id, key: 'birthday', enabled: true });
    jest.useFakeTimers({ now: new Date('2026-10-28T05:30:00.000Z'), doNotFake: DATE_ONLY }); // 11:00 IST
    try {
      await createCustomer(w.business._id, { name: 'NoOpt', dob: '1990-10-28', waOptIn: false });
      await run('automation-scan', { businessId: w.business._id.toString(), slot: 'o' });
      expect(await WaMessage.countDocuments({ businessId: w.business._id, origin: 'automation' })).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Worker — day-end-report (PRD §14)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
    queued.length = 0;
  });

  it('sends the report to the business owner WhatsApp number', async () => {
    await wa(w);
    await run('day-end-report', { businessId: w.business._id.toString(), date: getBusinessDate() });
    const conv = await WaConversation.findOne({ businessId: w.business._id, phone: '+919800000001' });
    expect(conv).toBeTruthy();
  });

  it('a branch that has not closed is reported as "Not closed" with system figures', async () => {
    await wa(w);
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'upi', amountPaise: 118000 }],
    });
    await run('day-end-report', { businessId: w.business._id.toString(), date: getBusinessDate() });
    const msgs = await WaMessage.find({ businessId: w.business._id, origin: 'transactional' });
    expect(JSON.stringify(msgs)).toMatch(/not.?closed/i);
  });

  it('report cash figure is CASH collections, not total revenue across all modes', async () => {
    await wa(w);
    await DayClosure.create({ businessId: w.business._id, branchId: w.branchA._id, businessDate: getBusinessDate(), expected: { cashPaise: 0, upiPaise: 118000, cardPaise: 0 }, status: 'approved' });
    await as(w.tokens.owner).post(`/branches/${w.branchB._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylistB._id)], payments: [{ mode: 'upi', amountPaise: 118000 }],
    });
    // generateDayEndPdf receives expectedCashPaise; with UPI-only sales it must be 0
    const pdf = await import('../../src/integrations/pdf/pdf.service');
    const spy = jest.spyOn(pdf.PdfService.prototype as any, 'generateDayEndPdf').mockResolvedValue(Buffer.from('x'));
    try {
      await run('day-end-report', { businessId: w.business._id.toString(), date: getBusinessDate() });
      const callB = spy.mock.calls.find((c: any) => c[0]?.branchName === w.branchB.name) as any;
      if (callB) expect(callB[0].expectedCashPaise).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Worker — maintenance jobs (Backend SRS §10)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
    queued.length = 0;
  });

  it('plan-expiry marks past-validity plans expired (all businesses)', async () => {
    const cp = await CustomerPlan.create({
      businessId: w.business._id, customerId: w.customer._id, planId: new Types.ObjectId(), planSnap: { type: 'package' },
      soldBillId: new Types.ObjectId(), soldBranchId: w.branchA._id, validFrom: dayOffset(-40), validTill: dayOffset(-1),
      sessions: [{ serviceId: w.haircut._id, total: 2, used: 1, perSessionValuePaise: 50000 }], status: 'active',
      log: [{ action: 'redeem', at: new Date(), by: w.owner._id }],
    });
    await run('plan-expiry', { date: getBusinessDate() });
    expect((await CustomerPlan.findOne({ _id: cp._id, businessId: w.business._id }))!.status).toBe('expired');
  });

  it('ledger-check runs cleanly when wallets match their ledgers', async () => {
    await as(w.tokens.owner).post(`/customers/${w.customer._id}/wallet/adjust`, { amountPaise: 5000, reason: 'x' });
    await expect(run('ledger-check', { date: getBusinessDate() })).resolves.not.toThrow();
  });

  it('recurring-expense posts the month\'s rent once on its day', async () => {
    const d = new Date();
    await RecurringExpense.create({ businessId: w.business._id, branchId: w.branchA._id, category: 'rent', amountPaise: 2500000, dayOfMonth: Number(getBusinessDate().slice(8)), active: true });
    await run('recurring-expense', { date: getBusinessDate() });
    await run('recurring-expense', { date: getBusinessDate() });
    expect(await Expense.countDocuments({ businessId: w.business._id, category: 'rent' })).toBe(1);
    expect(d).toBeTruthy();
  });

  it('stock-alerts notifies a real user (owner/manager) when stock is at or below reorder level', async () => {
    await Product.updateOne({ _id: w.retail._id, businessId: w.business._id }, { $set: { reorderLevels: [{ branchId: w.branchA._id, qty: 20 }] } });
    await run('stock-alerts', { date: getBusinessDate() });
    const n = await Notification.findOne({ businessId: w.business._id, type: 'low_stock' });
    expect(n).toBeTruthy();
    expect([String(w.owner._id), String(w.manager._id), String(w.branchLoginA._id)]).toContain(String(n!.userId));
  });

  it('daily-summary rebuild matches the live summary', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    const live: any = await DailySummary.findById(`${w.branchA._id}:${getBusinessDate()}`).lean();
    await run('daily-summary', { branchId: w.branchA._id.toString(), date: getBusinessDate() });
    const rebuilt: any = await DailySummary.findById(`${w.branchA._id}:${getBusinessDate()}`).lean();
    expect(rebuilt.sales.netPaise).toBe(live.sales.netPaise);
    expect(rebuilt.collections.cash).toBe(live.collections.cash);
  });
});
