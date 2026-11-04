import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World } from '../helpers/factory';
import { Customer, Lead, WaConversation, WaNumber } from '../../src/models';
import { encryptData, getBusinessDate, addDays } from '../../src/utils';

/*
 * Leads with customer details, numbered follow-ups and a notes timeline (2026-11-03).
 * Owners see every branch; managers and branch logins only their own (403 screen / 404 record).
 */
describe('Leads: details, follow-ups, notes and branch scope', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  const details = {
    name: 'Riya Mehta', phone: '9811100000', email: 'riya@example.com', gender: 'female',
    dob: '1995-04-12', anniversary: '2020-12-01', address: { line1: '4 Ring Road', city: 'Surat' },
    source: 'walk_in', budgetPaise: 150000,
  };
  const create = (token: string, branch = w.branchA, extra: any = {}) =>
    as(token).post('/leads', { branchId: branch._id.toString(), serviceIds: [w.colour._id.toString()], ...details, notes: 'Asked about keratin', ...extra });

  it('a lead holds the customer details, and converting copies them into the customer', async () => {
    const res = await create(w.tokens.branchA);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: 'riya@example.com', gender: 'female', dob: '1995-04-12', address: { line1: '4 Ring Road', city: 'Surat' } });
    expect(res.body.noteLog).toHaveLength(1);
    expect(res.body.noteLog[0]).toMatchObject({ text: 'Asked about keratin', by: { name: expect.any(String) } });

    const conv = await as(w.tokens.branchA).post(`/leads/${res.body._id}/convert`);
    expect(conv.status).toBe(200);
    const customer = await Customer.findOne({ businessId: w.business._id, phone: '+919811100000' });
    expect(customer).toMatchObject({ name: 'Riya Mehta', email: 'riya@example.com', gender: 'female', dob: '1995-04-12', anniversary: '2020-12-01', source: 'walk_in' });
    expect(customer!.address).toMatchObject({ line1: '4 Ring Road', city: 'Surat' });
  });

  it('follow-ups are numbered 1st, 2nd …, set the next date, move the stage and land in the notes', async () => {
    const lead = (await create(w.tokens.branchA)).body;
    const tomorrow = addDays(getBusinessDate(), 1);

    const first = await as(w.tokens.branchA).post(`/leads/${lead._id}/follow-ups`, { channel: 'call', outcome: 'no_answer', nextFollowUpDate: tomorrow });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ stage: 'contacted', followUpDate: tomorrow });
    expect(first.body.followUps[0]).toMatchObject({ number: 1, channel: 'call', outcome: 'no_answer', by: { name: expect.any(String) } });

    const second = await as(w.tokens.branchA).post(`/leads/${lead._id}/follow-ups`, { channel: 'whatsapp', outcome: 'interested', note: 'Coming Saturday' });
    expect(second.body.stage).toBe('interested');
    expect(second.body.followUps.map((f: any) => f.number)).toEqual([1, 2]);
    expect(second.body.followUpDate).toBeUndefined(); // no next date given: nothing due
    expect(second.body.noteLog.at(-1)).toMatchObject({ text: 'Coming Saturday', followUpNumber: 2 });

    const note = await as(w.tokens.branchA).post(`/leads/${lead._id}/notes`, { text: 'Prefers evenings' });
    expect(note.status).toBe(201);
    expect(note.body.noteLog.map((n: any) => n.text)).toEqual(['Asked about keratin', 'Coming Saturday', 'Prefers evenings']);
    expect((await as(w.tokens.branchA).post(`/leads/${lead._id}/notes`, { text: ' ' })).status).toBe(400);
  });

  it('lists follow-ups due today and overdue, open leads only, and searches name or phone', async () => {
    const today = getBusinessDate();
    const a = (await create(w.tokens.owner, w.branchA, { name: 'Due Today', phone: '9811100001', followUpDate: today })).body;
    await create(w.tokens.owner, w.branchA, { name: 'Overdue', phone: '9811100002', followUpDate: addDays(today, -2) });
    await create(w.tokens.owner, w.branchA, { name: 'Later', phone: '9811100003', followUpDate: addDays(today, 3) });
    const lost = (await create(w.tokens.owner, w.branchA, { name: 'Lost One', phone: '9811100004', followUpDate: today })).body;
    await as(w.tokens.owner).patch(`/leads/${lost._id}`, { stage: 'lost', lostReason: 'Moved city' });

    const due = await as(w.tokens.branchA).get('/leads?due=today');
    expect(due.body.map((l: any) => l.name)).toEqual(['Due Today']);
    expect((await as(w.tokens.branchA).get('/leads?due=overdue')).body.map((l: any) => l.name)).toEqual(['Overdue']);
    expect((await as(w.tokens.branchA).get('/leads?search=00001')).body.map((l: any) => l._id)).toEqual([a._id]);
    expect((await as(w.tokens.branchA).get('/leads?search=later')).body.map((l: any) => l.name)).toEqual(['Later']);
    expect((await as(w.tokens.branchA).get('/leads?branchId=nope')).status).toBe(400);
  });

  it('branch logins and managers see and change only their own branches\' leads; branch logins see the full phone', async () => {
    const a = (await create(w.tokens.owner, w.branchA)).body;
    const b = (await create(w.tokens.owner, w.branchB, { phone: '9811100009' })).body;

    const listA = await as(w.tokens.branchA).get('/leads');
    expect(listA.body.map((l: any) => l._id)).toEqual([a._id]);
    expect(listA.body[0].phone).toBe('+919811100000');
    expect((await as(w.tokens.branchA).get(`/leads/${a._id}`)).body.phone).toBe('+919811100000');

    // Another branch: its screen is 403, its records are 404
    expect((await as(w.tokens.branchA).get(`/leads?branchId=${w.branchB._id}`)).status).toBe(403);
    for (const req of [
      as(w.tokens.branchA).get(`/leads/${b._id}`),
      as(w.tokens.branchA).patch(`/leads/${b._id}`, { name: 'x' }),
      as(w.tokens.branchA).post(`/leads/${b._id}/follow-ups`, { outcome: 'no_answer' }),
      as(w.tokens.branchA).post(`/leads/${b._id}/notes`, { text: 'x' }),
      as(w.tokens.branchA).post(`/leads/${b._id}/convert`),
      as(w.tokens.manager).get(`/leads/${b._id}`),
    ]) {
      expect((await req).status).toBe(404);
    }
    // Moving a lead to a branch you don't have is refused
    expect((await as(w.tokens.branchA).patch(`/leads/${a._id}`, { branchId: w.branchB._id.toString() })).status).toBe(403);

    expect((await as(w.tokens.manager).get('/leads')).body.map((l: any) => l._id)).toEqual([a._id]);
    expect((await as(w.tokens.owner).get('/leads')).body).toHaveLength(2);
  });

  it('a lost lead can be edited and reopened (which clears the reason), but takes no follow-up until reopened', async () => {
    const lead = (await create(w.tokens.branchA)).body;
    await as(w.tokens.branchA).patch(`/leads/${lead._id}`, { stage: 'lost', lostReason: 'Too costly' });
    expect((await as(w.tokens.branchA).post(`/leads/${lead._id}/follow-ups`, { outcome: 'call_back' })).status).toBe(409);

    const edited = await as(w.tokens.branchA).patch(`/leads/${lead._id}`, { budgetPaise: 90000 });
    expect(edited.status).toBe(200);
    const reopened = await as(w.tokens.branchA).patch(`/leads/${lead._id}`, { stage: 'contacted' });
    expect(reopened.body).toMatchObject({ stage: 'contacted', budgetPaise: 90000 });
    expect(reopened.body.lostReason).toBeUndefined();
  });

  it('assigning to someone outside the business is refused; clearing the assignee and the due date works', async () => {
    const lead = (await create(w.tokens.owner, w.branchA, { assignedTo: w.manager._id.toString(), followUpDate: getBusinessDate() })).body;
    expect(lead.assignedTo).toMatchObject({ name: expect.any(String) });
    const bad = await as(w.tokens.owner).patch(`/leads/${lead._id}`, { assignedTo: '64b000000000000000000001' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.assignedTo).toBeDefined();
    const cleared = await as(w.tokens.owner).patch(`/leads/${lead._id}`, { assignedTo: null, followUpDate: null });
    expect(cleared.body.assignedTo).toBeUndefined();
    expect(cleared.body.followUpDate).toBeUndefined();
  });

  it('converting links the lead\'s WhatsApp chat to the new customer', async () => {
    const lead = (await create(w.tokens.owner)).body;
    const number = await WaNumber.create({
      businessId: w.business._id, phone: '+919800000099', branchIds: [], status: 'active', lowBalance: false,
      instantBroadcast: { uid: 'u1', userTokenEnc: encryptData('key'), webhookSecretEnc: encryptData('s3cret-for-tests-0001') },
    });
    const chat = await WaConversation.create({
      businessId: w.business._id, numberId: number._id, branchId: w.branchA._id, phone: '+919811100000', leadId: lead._id, lastInboundAt: new Date(), unread: 0,
    });
    const customer = (await as(w.tokens.owner).post(`/leads/${lead._id}/convert`)).body;
    expect((await WaConversation.findOne({ _id: chat._id, businessId: w.business._id }))!.customerId!.toString()).toBe(customer._id);
    expect((await Lead.findOne({ _id: lead._id, businessId: w.business._id }))!.customerId!.toString()).toBe(customer._id);
  });
});
