import '../helpers/testEnv';

// No Redis in tests: record campaign jobs instead of queueing them
const queued: { queue: string; data: any; opts: any }[] = [];
jest.mock('bullmq', () => ({
  Queue: class {
    constructor(public name: string) {}
    add(_name: string, data: any, opts: any) {
      queued.push({ queue: this.name, data, opts });
      return Promise.resolve({ id: 'job' });
    }
    close() {
      return Promise.resolve();
    }
  },
  Worker: class {
    on() {
      return this;
    }
    close() {
      return Promise.resolve();
    }
  },
}));
import http from 'http';
import { AddressInfo } from 'net';
import { io as ioClient, Socket } from 'socket.io-client';
import { useTestDb } from '../helpers/db';
import { app, as, createPlatformAdmin, createUser, platformToken, seedWorld, serviceLine, tokenFor, World } from '../helpers/factory';
import { Bill, Campaign, MarketingOffer, User, WaConversation, WaMessage, WaNumber, WaTemplate } from '../../src/models';
import { processInboundWebhook, reconnectAllWaNumbers } from '../../src/services/whatsapp.service';
import { instantBroadcastSocket } from '../../src/integrations/instantbroadcast/instantbroadcast.socket';
import { initSocketServer } from '../../src/socket';
import { encryptData } from '../../src/utils';

async function waSetup(w: World) {
  const number = await WaNumber.create({
    businessId: w.business._id, phone: '+919800000099',
    instantBroadcast: { uid: 'ib-uid-1', userTokenEnc: encryptData('key'), webhookSecretEnc: encryptData('s3cret-for-tests-0001') },
    branchIds: [], status: 'active', lowBalance: false,
  });
  const template = await WaTemplate.create({
    businessId: w.business._id, numberId: number._id, name: 'offer', category: 'marketing', body: 'Hi {{1}}', variables: ['name'], status: 'approved',
  });
  const convA = await WaConversation.create({
    businessId: w.business._id, numberId: number._id, branchId: w.branchA._id, phone: w.customer.phone,
    customerId: w.customer._id, lastInboundAt: new Date(), unread: 2, contactMeta: { pushName: 'Priya S' },
  });
  const convB = await WaConversation.create({
    businessId: w.business._id, numberId: number._id, branchId: w.branchB._id, phone: '+919811100000',
    lastInboundAt: new Date(), unread: 1, contactMeta: { pushName: 'Walk-in Lead' },
  });
  return { number, template, convA, convB };
}

describe('WhatsApp inbox: branch scope', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld({ gst: false });
  });

  it('branch logins and managers see and act only on their own branches\' chats', async () => {
    const { convA, convB } = await waSetup(w);
    for (const token of [w.tokens.branchA, w.tokens.manager]) {
      const u = () => as(token);
      const list = await u().get('/whatsapp/conversations');
      expect(list.status).toBe(200);
      expect(list.body.map((c: any) => c._id)).toEqual([convA._id.toString()]);
      expect((await u().get(`/whatsapp/conversations?branchId=${w.branchB._id}`)).status).toBe(403);
      expect((await u().get(`/whatsapp/conversations/${convB._id}`)).status).toBe(404);
      expect((await u().get(`/whatsapp/messages?conversationId=${convB._id}`)).status).toBe(404);
      expect((await u().post('/whatsapp/messages', { conversationId: convB._id.toString(), text: 'hi' })).status).toBe(404);
      expect((await u().post(`/whatsapp/conversations/${convB._id}/read`)).status).toBe(404);
      expect((await u().post(`/whatsapp/conversations/${convB._id}/notes`, { note: 'x' })).status).toBe(404);
    }
    expect((await as(w.tokens.owner).get('/whatsapp/conversations')).body).toHaveLength(2);

    // own branch works end to end, with the full number inside the chat
    const open = await as(w.tokens.branchA).get(`/whatsapp/conversations/${convA._id}`);
    expect(open.body.customerId.phone).toBe('+919876543210');
    const sent = await as(w.tokens.branchA).post('/whatsapp/messages', { conversationId: convA._id.toString(), text: 'See you at 4' });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ direction: 'out', kind: 'text', status: 'sent', origin: 'inbox' });
  });

  it('messages come oldest → newest in pages, and loading them does not mark the chat read', async () => {
    const { convA } = await waSetup(w);
    for (let i = 1; i <= 5; i++) {
      await WaMessage.create({ businessId: w.business._id, conversationId: convA._id, direction: 'in', kind: 'text', text: `m${i}`, status: 'delivered', createdAt: new Date(Date.now() - (10 - i) * 1000) });
    }
    const latest = await as(w.tokens.owner).get(`/whatsapp/messages?conversationId=${convA._id}&limit=3`);
    expect(latest.body.map((m: any) => m.text)).toEqual(['m3', 'm4', 'm5']);
    const older = await as(w.tokens.owner).get(`/whatsapp/messages?conversationId=${convA._id}&limit=3&skip=3`);
    expect(older.body.map((m: any) => m.text)).toEqual(['m1', 'm2']);
    expect((await WaConversation.findOne({ _id: convA._id, businessId: w.business._id }))!.unread).toBe(2);

    const read = await as(w.tokens.owner).post(`/whatsapp/conversations/${convA._id}/read`);
    expect(read.body.unread).toBe(0);
  });

  it('filters by unread and searches by contact name, customer name or phone digits', async () => {
    const { convA, convB } = await waSetup(w);
    await WaConversation.updateOne({ _id: convA._id, businessId: w.business._id }, { unread: 0 });
    const o = () => as(w.tokens.owner);
    expect((await o().get('/whatsapp/conversations?unreadOnly=true')).body.map((c: any) => c._id)).toEqual([convB._id.toString()]);
    expect((await o().get('/whatsapp/conversations?search=walk-in')).body.map((c: any) => c._id)).toEqual([convB._id.toString()]);
    expect((await o().get('/whatsapp/conversations?search=priya shah')).body.map((c: any) => c._id)).toEqual([convA._id.toString()]);
    expect((await o().get('/whatsapp/conversations?search=98111')).body.map((c: any) => c._id)).toEqual([convB._id.toString()]);
  });

  it('outside the 24-hour window free text is refused; an approved template still goes', async () => {
    const { convA, template } = await waSetup(w);
    await WaConversation.updateOne({ _id: convA._id, businessId: w.business._id }, { lastInboundAt: new Date(Date.now() - 25 * 3600 * 1000) });
    const text = await as(w.tokens.owner).post('/whatsapp/messages', { conversationId: convA._id.toString(), text: 'hi' });
    expect(text.status).toBe(422);
    expect(text.body.error.code).toBe('WINDOW_CLOSED');
    const tmpl = await as(w.tokens.owner).post('/whatsapp/messages', { conversationId: convA._id.toString(), templateId: template._id.toString(), variables: ['Priya'] });
    expect(tmpl.status).toBe(201);
    expect(tmpl.body.kind).toBe('template');
  });
});

describe('WhatsApp webhooks: secret required', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld({ gst: false });
  });

  it('rejects a missing or wrong secret and accepts the right one (query or header)', async () => {
    const { number } = await waSetup(w);
    const url = `/webhooks/instantbroadcast/ib-uid-1`;
    const body = { from: '9811122222', text: 'Hi, price for keratin?', providerMessageId: 'wamid.1' };
    expect((await as().post(url, body)).status).toBe(401);
    expect((await as().post(`${url}?secret=wrong`, body)).status).toBe(401);
    expect(await WaMessage.countDocuments({ businessId: w.business._id, direction: 'in' })).toBe(0);

    expect((await as().post(`${url}?secret=s3cret-for-tests-0001`, body)).status).toBe(200);
    expect((await as().post(url, { ...body, providerMessageId: 'wamid.2' }).set('x-webhook-secret', 's3cret-for-tests-0001')).status).toBe(200);
    expect(await WaMessage.countDocuments({ businessId: w.business._id, direction: 'in' })).toBe(2);
    expect((await as().post(`/webhooks/instantbroadcast/${number._id}?secret=s3cret-for-tests-0001`, { ...body, providerMessageId: 'wamid.3' })).status).toBe(200);
  });

  it('configuring a number generates a strong secret and returns the webhook URL; saving again keeps it', async () => {
    const admin = await createPlatformAdmin();
    const cfg = { phone: '+919800000077', uid: 'ib-uid-9', userToken: 'key' };
    const first = await as(platformToken(admin)).post(`/admin/businesses/${w.business._id}/wa-config`, cfg);
    expect(first.status).toBe(200);
    expect(first.body.webhookUrl).toMatch(/^\/webhooks\/instantbroadcast\/ib-uid-9\?secret=[0-9a-f]{48}$/);
    const again = await as(platformToken(admin)).post(`/admin/businesses/${w.business._id}/wa-config`, cfg);
    expect(again.body.webhookUrl).toBe(first.body.webhookUrl);
  });
});

describe('WhatsApp sockets: events reach only the right branches', () => {
  useTestDb();
  let w: World;
  let server: http.Server;
  let url: string;
  const clients: Socket[] = [];

  beforeEach(async () => {
    w = await seedWorld({ gst: false });
    server = http.createServer(app);
    initSocketServer(server);
    await new Promise<void>((r) => server.listen(0, r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.disconnect());
    await new Promise((r) => server.close(r));
  });

  const connect = (token: string) =>
    new Promise<Socket>((resolve, reject) => {
      const c = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
      clients.push(c);
      c.on('connect', () => resolve(c));
      c.on('connect_error', reject);
    });
  const collect = (c: Socket, event: string) => {
    const got: any[] = [];
    c.on(event, (p) => got.push(p));
    return got;
  };

  it('an inbound branch-A message goes to the owner and branch A, never to branch B', async () => {
    const { number, convA } = await waSetup(w);
    const [owner, branchA, branchB] = await Promise.all([connect(w.tokens.owner), connect(w.tokens.branchA), connect(w.tokens.branchB)]);
    const seen = { owner: collect(owner, 'wa:new_message'), a: collect(branchA, 'wa:new_message'), b: collect(branchB, 'wa:new_message') };

    await processInboundWebhook(number._id, { from: w.customer.phone, text: 'Running 10 min late', providerMessageId: 'wamid.late' });
    await new Promise((r) => setTimeout(r, 300));

    expect(seen.owner).toHaveLength(1);
    expect(seen.a).toHaveLength(1);
    expect(String(seen.a[0].conversationId)).toBe(convA._id.toString());
    expect(seen.a[0].message).toMatchObject({ direction: 'in', text: 'Running 10 min late' });
    expect(seen.b).toHaveLength(0);
  });

  it('refuses a deactivated user and a revoked session', async () => {
    const gone = await createUser(w.business._id, { role: 'manager', branchIds: [w.branchA._id] });
    const token = tokenFor(gone);
    await User.updateOne({ _id: gone._id, businessId: w.business._id }, { status: 'inactive' });
    await expect(connect(token)).rejects.toThrow();

    const revoked = await createUser(w.business._id, { role: 'manager', branchIds: [w.branchA._id] });
    const old = tokenFor(revoked);
    await as(w.tokens.owner).patch(`/business/managers/${revoked._id}`, { branchIds: [w.branchB._id.toString()] }); // bumps the session version
    await expect(connect(old)).rejects.toThrow();
  });
});

describe('Marketing offers on bills', () => {
  useTestDb();
  let w: World;
  const offer = (over: any = {}) => ({
    code: 'DIWALI25', title: 'Diwali 25 % off', discountType: 'percentage', discountValue: 2500, maxDiscountPaise: 150000,
    validFrom: '2026-01-01', validTill: '2099-12-31', usageLimitPerCustomer: 1, ...over,
  });
  const bill = (w: World, extra: any = {}) => ({
    customerId: w.customer._id.toString(), billedByStaffId: w.receptionist._id.toString(),
    lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 75000 }], ...extra,
  });
  beforeEach(async () => {
    w = await seedWorld({ gst: false });
  });

  it('percentages are basis points: above 10000 is refused', async () => {
    const r = await as(w.tokens.owner).post('/marketing/offers', offer({ discountValue: 25000 }));
    expect(r.status).toBe(400);
    expect(r.body.error.fields.discountValue).toMatch(/basis points/);
  });

  it('the server applies the offer, ignores a client discount, and does not hold it for the front-desk limit', async () => {
    const o = await as(w.tokens.owner).post('/marketing/offers', offer());
    expect(o.status).toBe(201);

    const preview = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills/preview`, bill(w, { marketingOffer: { code: 'diwali25' } }));
    expect(preview.body.offer).toMatchObject({ code: 'DIWALI25', discountPaise: 25000 });
    expect(preview.body.payablePaise).toBe(75000);
    expect(preview.body.needsApproval).toBe(false); // 25 % > the 10 % branch limit, but the owner's offer is pre-approved

    const b = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, bill(w, { marketingOffer: { code: 'DIWALI25', discountPaise: 99999 } }));
    expect(b.status).toBe(201);
    expect(b.body.status).toBe('paid');
    expect(b.body.totals).toMatchObject({ grossPaise: 100000, discountPaise: 25000, totalPaise: 75000, duePaise: 0 });
    expect(b.body.marketingOffer).toMatchObject({ code: 'DIWALI25', discountPaise: 25000 });
    expect((await MarketingOffer.findOne({ _id: o.body._id, businessId: w.business._id }))!.totalUsedCount).toBe(1);

    const again = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, bill(w, { marketingOffer: { code: 'DIWALI25' } }));
    expect(again.status).toBe(422); // once per customer
  });

  it('a held bill counts the offer only when approved; cancelling takes the use and conversion back', async () => {
    const o = await as(w.tokens.owner).post('/marketing/offers', offer({ usageLimitPerCustomer: 5 }));
    const { number, template } = await waSetup(w);
    const camp = await Campaign.create({
      businessId: w.business._id, name: 'Diwali', numberId: number._id, templateId: template._id,
      audience: { kind: 'selection', customerIds: [w.customer._id] }, status: 'completed', stats: { total: 1 },
    });
    const held = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, bill(w, {
      marketingOffer: { code: 'DIWALI25', campaignId: camp._id.toString() }, payments: [{ mode: 'cash', amountPaise: 50000 }],
    }));
    expect(held.body.status).toBe('awaiting_approval'); // part-paid
    expect((await MarketingOffer.findOne({ _id: o.body._id, businessId: w.business._id }))!.totalUsedCount).toBe(0);

    await as(w.tokens.manager).post(`/bills/${held.body._id}/decide`, { decision: 'approve' });
    expect((await MarketingOffer.findOne({ _id: o.body._id, businessId: w.business._id }))!.totalUsedCount).toBe(1);
    expect((await Campaign.findOne({ _id: camp._id, businessId: w.business._id }))!.stats.conversions).toMatchObject({ billsCount: 1, revenuePaise: 75000, discountGivenPaise: 25000 });

    await as(w.tokens.owner).post(`/bills/${held.body._id}/cancel`, { reason: 'Wrong customer' });
    expect((await MarketingOffer.findOne({ _id: o.body._id, businessId: w.business._id }))!.totalUsedCount).toBe(0);
    expect((await Campaign.findOne({ _id: camp._id, businessId: w.business._id }))!.stats.conversions!.billsCount).toBe(0);
  });

  it('unknown, expired or out-of-branch codes are refused; offers need a customer', async () => {
    await as(w.tokens.owner).post('/marketing/offers', offer({ code: 'OLD10', validFrom: '2020-01-01', validTill: '2020-12-31' }));
    await as(w.tokens.owner).post('/marketing/offers', offer({ code: 'VESUONLY', branchScope: [w.branchB._id.toString()] }));
    const b = (code: string) => as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, bill(w, { marketingOffer: { code } }));
    expect((await b('NOPE')).status).toBe(404);
    expect((await b('OLD10')).body.error.message).toBe('Offer has expired');
    expect((await b('VESUONLY')).body.error.message).toBe('Offer is not valid at this branch');

    const val = await as(w.tokens.branchA).post('/marketing/offers/validate', { code: 'NOPE', customerId: w.customer._id.toString(), grossPaise: 100000 });
    expect(val.status).toBe(404);
    expect(await Bill.countDocuments({ businessId: w.business._id })).toBe(0);
  });
});

describe('Marketing segments and campaigns: access', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld({ gst: false, managerFlags: { manageMarketing: false } });
  });

  it('owners build; managers view (build with manageMarketing); branch logins only validate codes', async () => {
    const { number, template } = await waSetup(w);
    const segs = await as(w.tokens.owner).get('/marketing/segments');
    expect(segs.status).toBe(200);
    expect(segs.body.predefined.length).toBeGreaterThan(0);

    const prev = await as(w.tokens.owner).post('/marketing/segments/preview', { criteria: { customerType: 'all' } });
    expect(prev.status).toBe(200);
    expect(prev.body).toMatchObject({ totalMatched: 1, eligibleForWa: 1, excludedOptOut: 0 });

    const seg = await as(w.tokens.owner).post('/marketing/segments', { name: 'Everyone', criteria: { customerType: 'all' } });
    expect(seg.status).toBe(201);

    const camp = await as(w.tokens.owner).post('/marketing/campaigns', {
      name: 'Diwali', numberId: number._id.toString(), templateId: template._id.toString(),
      audience: { kind: 'selection', customerIds: [w.customer._id.toString()] }, variableMap: { '1': '{{customer_name}}' },
    });
    expect(camp.status).toBe(201);
    expect(camp.body.status).toBe('draft');
    const sched = await as(w.tokens.owner).post(`/marketing/campaigns/${camp.body._id}/schedule`, { scheduledAt: '2099-11-05T10:00:00.000Z' });
    expect(sched.body.status).toBe('scheduled');
    expect(queued.some((q) => q.queue === 'campaign-send' && q.data.campaignId === camp.body._id)).toBe(true);
    expect((await as(w.tokens.owner).get(`/marketing/campaigns/${camp.body._id}/analytics`)).status).toBe(200);

    expect((await as(w.tokens.manager).get('/marketing/campaigns')).status).toBe(200);
    expect((await as(w.tokens.manager).post('/marketing/segments', { name: 'M', criteria: { customerType: 'all' } })).status).toBe(403);
    expect((await as(w.tokens.branchA).get('/marketing/campaigns')).status).toBe(403);
    expect((await as(w.tokens.branchA).get('/marketing/segments')).status).toBe(403);
  });
});

describe('WhatsApp across businesses: each owner sees only their own number and chats', () => {
  useTestDb();
  let w: World;
  let server: http.Server;
  let url: string;
  const clients: Socket[] = [];

  beforeEach(async () => {
    w = await seedWorld({ gst: false });
    server = http.createServer(app);
    initSocketServer(server);
    await new Promise<void>((r) => server.listen(0, r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.disconnect());
    await new Promise((r) => server.close(r));
  });

  const connect = (token: string) =>
    new Promise<Socket>((resolve, reject) => {
      const c = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
      clients.push(c);
      c.on('connect', () => resolve(c));
      c.on('connect_error', reject);
    });

  it('webhooks land in the number\'s own business; REST, sends and live events never cross over', async () => {
    const { number: numA } = await waSetup(w); // Glamour Studio, uid ib-uid-1
    const numB = await WaNumber.create({
      businessId: w.otherBusiness._id, phone: '+919800000088', branchIds: [w.otherBranch._id],
      instantBroadcast: { uid: 'ib-uid-rival', userTokenEnc: encryptData('key'), webhookSecretEnc: encryptData('rival-secret-000001') },
      status: 'active', lowBalance: false,
    });
    const ownerA = await connect(w.tokens.owner);
    const ownerB = await connect(w.tokens.otherOwner);
    const seenA: any[] = [];
    const seenB: any[] = [];
    ownerA.on('wa:new_message', (p) => seenA.push(p));
    ownerB.on('wa:new_message', (p) => seenB.push(p));

    // the same customer phone writes to both salons
    await as().post('/webhooks/instantbroadcast/ib-uid-1?secret=s3cret-for-tests-0001', { from: '+919777700000', text: 'Hi Glamour', providerMessageId: 'wamid.x1' });
    await as().post('/webhooks/instantbroadcast/ib-uid-rival?secret=rival-secret-000001', { from: '+919777700000', text: 'Hi Rival', providerMessageId: 'wamid.x2' });
    // each number's secret works only for that number
    expect((await as().post('/webhooks/instantbroadcast/ib-uid-rival?secret=s3cret-for-tests-0001', { from: '1', text: 'x' })).status).toBe(401);
    await new Promise((r) => setTimeout(r, 300));

    expect(seenA.map((p) => p.message.text)).toEqual(['Hi Glamour']);
    expect(seenB.map((p) => p.message.text)).toEqual(['Hi Rival']);

    const listA = (await as(w.tokens.owner).get('/whatsapp/conversations')).body;
    const listB = (await as(w.tokens.otherOwner).get('/whatsapp/conversations')).body;
    expect(listB).toHaveLength(1);
    expect(String(listB[0].numberId)).toBe(numB._id.toString());
    expect(String(listB[0].branchId)).toBe(w.otherBranch._id.toString());
    expect(listA.every((c: any) => String(c.numberId) === numA._id.toString())).toBe(true);

    // a rival owner can't open, read or reply to Glamour's chat, even with its id
    const glamourChat = listA.find((c: any) => c.phone === '+919777700000');
    expect((await as(w.tokens.otherOwner).get(`/whatsapp/conversations/${glamourChat._id}`)).status).toBe(404);
    expect((await as(w.tokens.otherOwner).get(`/whatsapp/messages?conversationId=${glamourChat._id}`)).status).toBe(404);
    expect((await as(w.tokens.otherOwner).post('/whatsapp/messages', { conversationId: glamourChat._id, text: 'hi' })).status).toBe(404);
    expect((await as(w.tokens.otherOwner).get('/whatsapp/templates')).body).toHaveLength(0);

    // replies go out from each salon's own number and only reach that salon's screens
    seenA.length = 0;
    seenB.length = 0;
    await as(w.tokens.otherOwner).post('/whatsapp/messages', { conversationId: listB[0]._id, text: 'Hello from Rival' });
    await new Promise((r) => setTimeout(r, 200));
    expect(seenB.map((p) => p.message.text)).toEqual(['Hello from Rival']);
    expect(seenA).toHaveLength(0);
  });
});

describe('WhatsApp accounts: one business per account', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld({ gst: false });
  });
  afterEach(() => jest.restoreAllMocks());

  it('refuses a uid or phone already connected to another business; the same business can re-save', async () => {
    const connect = jest.spyOn(instantBroadcastSocket, 'connectAccount').mockImplementation(() => ({}) as any);
    const admin = as(platformToken(await createPlatformAdmin()));
    const cfg = { phone: '+919800000077', uid: 'ib-uid-9', userToken: 'key' };
    expect((await admin.post(`/admin/businesses/${w.business._id}/wa-config`, cfg)).status).toBe(200);
    expect((await admin.post(`/admin/businesses/${w.business._id}/wa-config`, cfg)).status).toBe(200);

    const sameUid = await admin.post(`/admin/businesses/${w.otherBusiness._id}/wa-config`, { ...cfg, phone: '+919800000066' });
    expect(sameUid.status).toBe(409);
    expect(sameUid.body.error).toMatchObject({ code: 'ALREADY_EXISTS', message: 'This WhatsApp account is already connected to another business', fields: { uid: 'Already used by another business' } });
    const samePhone = await admin.post(`/admin/businesses/${w.otherBusiness._id}/wa-config`, { ...cfg, uid: 'ib-uid-other' });
    expect(samePhone.body.error.fields).toEqual({ phone: 'Already used by another business' });
    expect(await WaNumber.countDocuments({ businessId: w.otherBusiness._id })).toBe(0);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('a uid saved twice before this check drops the webhook instead of guessing the salon', async () => {
    for (const businessId of [w.business._id, w.otherBusiness._id]) {
      await WaNumber.create({
        businessId, phone: `+9198000000${businessId === w.business._id ? '11' : '22'}`, status: 'active', lowBalance: false, branchIds: [],
        instantBroadcast: { uid: 'shared-uid', userTokenEnc: encryptData('key'), webhookSecretEnc: encryptData('shared-secret-00001') },
      });
    }
    const r = await as().post('/webhooks/instantbroadcast/shared-uid?secret=shared-secret-00001', { from: '+919777700000', text: 'hi', providerMessageId: 'wamid.s1' });
    expect(r.status).toBe(200);
    expect(await WaMessage.countDocuments({ businessId: { $in: [w.business._id, w.otherBusiness._id] } })).toBe(0);
  });

  it('server start reconnects every active number of every business', async () => {
    const connect = jest.spyOn(instantBroadcastSocket, 'connectAccount').mockImplementation(() => ({}) as any);
    await waSetup(w);
    await WaNumber.create({
      businessId: w.otherBusiness._id, phone: '+919800000088', status: 'active', lowBalance: false, branchIds: [],
      instantBroadcast: { uid: 'ib-uid-rival', userTokenEnc: encryptData('rival-token'), webhookSecretEnc: encryptData('rival-secret-000001') },
    });
    await WaNumber.create({
      businessId: w.otherBusiness._id, phone: '+919800000089', status: 'error', lowBalance: false, branchIds: [],
      instantBroadcast: { uid: 'ib-uid-broken', userTokenEnc: encryptData('x'), webhookSecretEnc: encryptData('broken-secret-00001') },
    });
    expect(await reconnectAllWaNumbers()).toBe(2);
    expect(connect.mock.calls.map((c) => [c[0].uid, c[0].userToken, c[0].businessId]).sort()).toEqual([
      ['ib-uid-1', 'key', w.business._id.toString()],
      ['ib-uid-rival', 'rival-token', w.otherBusiness._id.toString()],
    ]);
  });

  it('the same provider message id in two businesses is stored for both', async () => {
    const { number } = await waSetup(w);
    const rival = await WaNumber.create({
      businessId: w.otherBusiness._id, phone: '+919800000088', status: 'active', lowBalance: false, branchIds: [w.otherBranch._id],
      instantBroadcast: { uid: 'ib-uid-rival', userTokenEnc: encryptData('key'), webhookSecretEnc: encryptData('rival-secret-000001') },
    });
    await WaMessage.init();
    await processInboundWebhook(number._id, { from: '+919777700000', text: 'one', providerMessageId: 'wamid.same' });
    await processInboundWebhook(rival._id, { from: '+919777700000', text: 'two', providerMessageId: 'wamid.same' });
    await processInboundWebhook(rival._id, { from: '+919777700000', text: 'two again', providerMessageId: 'wamid.same' }); // retry: ignored
    expect(await WaMessage.countDocuments({ businessId: w.business._id, providerMessageId: 'wamid.same' })).toBe(1);
    expect(await WaMessage.countDocuments({ businessId: w.otherBusiness._id, providerMessageId: 'wamid.same' })).toBe(1);
  });
});
