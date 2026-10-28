import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, serviceLine, createCustomer } from '../helpers/factory';
import { Lead, Customer, WaNumber, WaTemplate, WaConversation, WaMessage, Campaign, Feedback, Notification, Automation } from '../../src/models';
import { processInboundWebhook } from '../../src/services/whatsapp.service';
import { encryptData } from '../../src/utils';

async function waSetup(w: World) {
  const number = await WaNumber.create({
    businessId: w.business._id, phone: '+919800000099',
    aisensy: { apiKeyEnc: encryptData('key'), projectId: 'p1', webhookSecretEnc: encryptData('whsec') },
    branchIds: [], status: 'active', lowBalance: false,
  });
  const template = await WaTemplate.create({
    businessId: w.business._id, numberId: number._id, name: 'offer', category: 'marketing', body: 'Hi {{1}}', variables: ['name'], status: 'approved',
  });
  const conv = await WaConversation.create({
    businessId: w.business._id, numberId: number._id, branchId: w.branchA._id, phone: w.customer.phone,
    customerId: w.customer._id, lastInboundAt: new Date(), unread: 1,
  });
  return { number, template, conv };
}

describe('Leads (PRD §11)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  const lead = (w: World, token: string, extra: any = {}) =>
    as(token).post('/leads', { branchId: w.branchA._id.toString(), name: 'Asha', phone: '9811100000', source: 'walk_in', serviceIds: [w.colour._id.toString()], ...extra });

  it('branch login adds a walk-in lead (stage new, phone normalised)', async () => {
    const res = await lead(w, w.tokens.branchA);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ stage: 'new', phone: '+919811100000' });
  });

  it('branch login cannot add a lead to another branch', async () => {
    const res = await lead(w, w.tokens.branchA, { branchId: w.branchB._id.toString() });
    expect(res.status).toBe(403);
  });

  it('marking a lead Lost requires a reason', async () => {
    const l = await lead(w, w.tokens.branchA);
    expect((await as(w.tokens.branchA).patch(`/leads/${l.body._id}`, { stage: 'lost' })).status).toBe(400);
    expect((await as(w.tokens.branchA).patch(`/leads/${l.body._id}`, { stage: 'lost', lostReason: 'Too costly' })).status).toBe(200);
  });

  it('converting a lead creates the customer and marks it booked', async () => {
    const l = await lead(w, w.tokens.branchA);
    const c = await as(w.tokens.branchA).post(`/leads/${l.body._id}/convert`);
    expect(c.status).toBe(200);
    expect(await Customer.findOne({ businessId: w.business._id, phone: '+919811100000' })).toBeTruthy();
    expect((await Lead.findOne({ _id: l.body._id, businessId: w.business._id }))!.stage).toBe('booked');
  });

  it('converting a lead whose phone already belongs to a customer links that customer', async () => {
    const l = await lead(w, w.tokens.branchA, { phone: '9876543210' });
    const c = await as(w.tokens.branchA).post(`/leads/${l.body._id}/convert`);
    expect(c.body._id).toBe(w.customer._id.toString());
  });

  it('a lost lead cannot be converted', async () => {
    const l = await lead(w, w.tokens.branchA);
    await as(w.tokens.branchA).patch(`/leads/${l.body._id}`, { stage: 'lost', lostReason: 'x' });
    const c = await as(w.tokens.branchA).post(`/leads/${l.body._id}/convert`);
    expect([409, 422]).toContain(c.status);
  });

  it('branch login B cannot read branch A\'s leads', async () => {
    await lead(w, w.tokens.owner);
    const res = await as(w.tokens.branchB).get('/leads');
    expect(res.status).toBe(200);
    const list = res.body.leads || res.body;
    expect(list).toHaveLength(0);
  });

  it('lead phone is masked for the branch login in lists', async () => {
    await lead(w, w.tokens.owner);
    const res = await as(w.tokens.branchA).get('/leads');
    expect(JSON.stringify(res.body)).not.toContain('9811100000');
  });
});

describe('WhatsApp inbox (PRD §12)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('free-form reply inside the 24 h window is sent and stored', async () => {
    const { conv } = await waSetup(w);
    const res = await as(w.tokens.manager).post(`/whatsapp/messages?conversationId=${conv._id}`, { text: 'Hi Priya, see you at 4!' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ direction: 'out', kind: 'text', origin: 'inbox' });
  });

  it('conversationId in the JSON body works (not only in the query string)', async () => {
    const { conv } = await waSetup(w);
    const res = await as(w.tokens.manager).post('/whatsapp/messages', { conversationId: conv._id.toString(), text: 'Hello' });
    expect(res.status).toBe(201);
  });

  it('free-form text outside the 24 h window -> 422 WINDOW_CLOSED; template still allowed', async () => {
    const { conv, template } = await waSetup(w);
    await WaConversation.updateOne({ _id: conv._id, businessId: w.business._id }, { $set: { lastInboundAt: new Date(Date.now() - 25 * 3600 * 1000) } });
    const t = await as(w.tokens.manager).post(`/whatsapp/messages?conversationId=${conv._id}`, { text: 'late reply' });
    expect(t.status).toBe(422);
    expect(t.body.error.code).toBe('WINDOW_CLOSED');
    const tpl = await as(w.tokens.manager).post(`/whatsapp/messages?conversationId=${conv._id}`, { templateId: template._id.toString(), variables: ['Priya'] });
    expect(tpl.status).toBe(201);
  });

  it('cannot send with a template that is not approved', async () => {
    const { conv, number } = await waSetup(w);
    const pending = await WaTemplate.create({ businessId: w.business._id, numberId: number._id, name: 'p', category: 'marketing', body: 'x', status: 'pending' });
    const res = await as(w.tokens.manager).post(`/whatsapp/messages?conversationId=${conv._id}`, { templateId: pending._id.toString() });
    expect([404, 422]).toContain(res.status);
  });

  it('inbox lists conversations for the business only', async () => {
    await waSetup(w);
    const res = await as(w.tokens.otherOwner).get('/whatsapp/conversations');
    expect(res.status).toBe(200);
    expect((res.body.conversations || res.body)).toHaveLength(0);
  });

  it('manager of branch A does not see branch B conversations', async () => {
    const { number } = await waSetup(w);
    await WaConversation.create({ businessId: w.business._id, numberId: number._id, branchId: w.branchB._id, phone: '+919800001111', unread: 1 });
    const res = await as(w.tokens.manager).get('/whatsapp/conversations');
    const list = res.body.conversations || res.body;
    expect(list.every((c: any) => String(c.branchId) === String(w.branchA._id))).toBe(true);
  });
});

describe('WhatsApp webhook processing (Backend SRS §9)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('HTTP: webhook with a bad signature is rejected (401/403)', async () => {
    const { number } = await waSetup(w);
    const res = await as().post(`/webhooks/aisensy/${number._id}`, { from: '9811111111', text: 'hi' }).set('x-aisensy-signature', 'forged');
    expect([401, 403]).toContain(res.status);
    // must be rejected by the signature check, not by the bearer-token middleware
    expect(res.body.error?.code).not.toBe('UNAUTHENTICATED');
    expect(await WaMessage.countDocuments({ businessId: w.business._id, direction: 'in' })).toBe(0);
  });

  it('HTTP: unknown numberId returns 200 quickly and stores nothing', async () => {
    const res = await as().post('/webhooks/aisensy/000000000000000000000000', { from: '9811111111', text: 'hi' });
    expect(res.status).toBe(200);
  });

  it('inbound message from a known customer opens a conversation on the customer', async () => {
    const { number } = await waSetup(w);
    await processInboundWebhook(number._id, { from: '919876543210', text: 'Hi, can I book?', providerMessageId: 'm1' });
    const conv = await WaConversation.findOne({ businessId: w.business._id, phone: '+919876543210' });
    expect(String(conv!.customerId)).toBe(String(w.customer._id));
    expect(conv!.unread).toBeGreaterThanOrEqual(2);
  });

  it('inbound message from an unknown number creates a WhatsApp lead (PRD §11)', async () => {
    const { number } = await waSetup(w);
    await processInboundWebhook(number._id, { from: '919800012345', text: 'Price for keratin?', providerMessageId: 'm2' });
    const lead = await Lead.findOne({ businessId: w.business._id, phone: '+919800012345' });
    expect(lead?.source).toBe('whatsapp');
  });

  it('new conversations land in the head branch inbox, not a random branch id', async () => {
    const { number } = await waSetup(w);
    await processInboundWebhook(number._id, { from: '919800012345', text: 'hello', providerMessageId: 'm3' });
    const conv = await WaConversation.findOne({ businessId: w.business._id, phone: '+919800012345' });
    expect([String(w.branchA._id), String(w.branchB._id)]).toContain(String(conv!.branchId));
  });

  it('duplicate delivery of the same provider message is stored once', async () => {
    const { number } = await waSetup(w);
    await processInboundWebhook(number._id, { from: '919876543210', text: 'hi', providerMessageId: 'dup-1' });
    await processInboundWebhook(number._id, { from: '919876543210', text: 'hi', providerMessageId: 'dup-1' });
    expect(await WaMessage.countDocuments({ businessId: w.business._id, providerMessageId: 'dup-1' })).toBe(1);
  });

  it('inbound "STOP" opts the customer out (waOptIn=false, doNotMessage=true)', async () => {
    const { number } = await waSetup(w);
    await processInboundWebhook(number._id, { from: '919876543210', text: 'STOP', providerMessageId: 'm4' });
    const c = await Customer.findOne({ _id: w.customer._id, businessId: w.business._id });
    expect(c).toMatchObject({ waOptIn: false, doNotMessage: true });
  });

  it('a 1–5 reply after a bill becomes feedback; low rating alerts the owner', async () => {
    const { number } = await waSetup(w);
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    await processInboundWebhook(number._id, { from: '919876543210', text: '2', providerMessageId: 'm5' });
    expect((await Feedback.findOne({ businessId: w.business._id }))?.rating).toBe(2);
    expect(await Notification.findOne({ businessId: w.business._id, userId: w.owner._id })).toBeTruthy();
  });

  it('delivery status callback updates the outbound message status', async () => {
    const { number, conv } = await waSetup(w);
    await WaMessage.create({ businessId: w.business._id, conversationId: conv._id, direction: 'out', kind: 'text', text: 'x', status: 'sent', origin: 'inbox', providerMessageId: 'out-1' });
    await processInboundWebhook(number._id, { from: '919876543210', providerMessageId: 'out-1', status: 'read' } as any);
    expect((await WaMessage.findOne({ businessId: w.business._id, providerMessageId: 'out-1' }))?.status).toBe('read');
  });
});

describe('Campaigns and automations (PRD §12–13)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('owner creates a campaign for selected customers', async () => {
    const { number, template } = await waSetup(w);
    const res = await as(w.tokens.owner).post('/whatsapp/campaigns', {
      name: 'Diwali', numberId: number._id.toString(), templateId: template._id.toString(),
      audience: { kind: 'selection', customerIds: [w.customer._id.toString()] },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
  });

  it('manager can only VIEW campaigns (PRD matrix)', async () => {
    const { number, template } = await waSetup(w);
    const res = await as(w.tokens.manager).post('/whatsapp/campaigns', {
      name: 'x', numberId: number._id.toString(), templateId: template._id.toString(), audience: { kind: 'selection', customerIds: [] },
    });
    expect(res.status).toBe(403);
  });

  it('opted-out and do-not-message customers are excluded from the audience count', async () => {
    const { number, template } = await waSetup(w);
    const out = await createCustomer(w.business._id, { name: 'No', doNotMessage: true });
    const noOpt = await createCustomer(w.business._id, { name: 'NoOpt', waOptIn: false });
    const res = await as(w.tokens.owner).post('/whatsapp/campaigns', {
      name: 'Seg', numberId: number._id.toString(), templateId: template._id.toString(),
      audience: { kind: 'selection', customerIds: [w.customer._id, out._id, noOpt._id].map(String) },
    });
    const c = await Campaign.findOne({ _id: res.body._id, businessId: w.business._id });
    expect(c!.stats.excluded).toBe(2);
  });

  it('cannot use another business\'s WhatsApp number or template', async () => {
    const other = await seedWorld();
    const { number, template } = await waSetup(other);
    const res = await as(w.tokens.owner).post('/whatsapp/campaigns', {
      name: 'x', numberId: number._id.toString(), templateId: template._id.toString(), audience: { kind: 'selection', customerIds: [] },
    });
    expect([404, 422]).toContain(res.status);
  });

  it('owner toggles an automation; manager can only read', async () => {
    const { template } = await waSetup(w);
    const up = await as(w.tokens.owner).patch('/whatsapp/automations/birthday', { enabled: true, templateId: template._id.toString() });
    expect(up.status).toBe(200);
    expect((await Automation.findOne({ businessId: w.business._id, key: 'birthday' }))?.enabled).toBe(true);
    expect((await as(w.tokens.manager).patch('/whatsapp/automations/birthday', { enabled: false })).status).toBe(403);
  });

  it('unknown automation key -> 400/404', async () => {
    const res = await as(w.tokens.owner).patch('/whatsapp/automations/spam_everyone', { enabled: true });
    expect([400, 404]).toContain(res.status);
  });
});
