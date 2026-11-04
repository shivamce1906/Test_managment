/**
 * Adds sample leads to the LOCAL test backend through its API (same validation as the screens):
 * both branches, every stage, follow-ups due today / overdue / later, 1st–3rd follow-ups, notes,
 * an assignee, lost (with reason), a reopened lead and a converted one.
 *
 *   npx tsx scripts/seed-sample-leads.ts            (API defaults to http://localhost:4100)
 *
 * Safe to re-run: a lead whose phone already exists is skipped. Refuses any non-local API.
 */
const API = process.env.API_URL || 'http://localhost:4100';
const PASSWORD = 'Test@1234';
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(API)) throw new Error(`Refusing non-local API ${API}`);

type FollowUp = { channel?: string; outcome: string; note?: string; next?: number | null };
type Spec = {
  as: 'branch' | 'branch2' | 'owner';
  branch: 'TST1' | 'TST2';
  lead: Record<string, unknown>;
  services: string[];
  /** Days from today (IST) for the next follow-up; negative = overdue */
  due?: number;
  assign?: 'manager' | 'manager2';
  followUps?: FollowUp[];
  notes?: string[];
  then?: { lost?: string; reopen?: boolean; convert?: boolean };
};

const SPECS: Spec[] = [
  // Test Branch (TST1), worked by branch@glox.test
  { as: 'branch', branch: 'TST1', services: ['Classic Facial'], due: 0,
    lead: { name: 'Ananya Kapoor', phone: '9825010001', source: 'walk_in', gender: 'female', budgetPaise: 200000, notes: 'Walked in, asked for a facial before her sister\'s wedding' } },
  { as: 'branch', branch: 'TST1', services: [], due: 0,
    lead: { name: 'Rahul Verma', phone: '9825010002', source: 'phone', gender: 'male', notes: 'Called about a beard and hair package' },
    followUps: [{ outcome: 'no_answer', next: 0 }] },
  { as: 'branch', branch: 'TST1', services: ['Classic Facial'],
    lead: { name: 'Sneha Patel', phone: '9825010003', source: 'whatsapp', gender: 'female', email: 'sneha.patel@example.com' },
    followUps: [
      { channel: 'whatsapp', outcome: 'no_answer', next: -4 },
      { channel: 'call', outcome: 'call_back', note: 'Busy at work, call after 6 pm', next: -2 },
    ] },
  { as: 'branch', branch: 'TST1', services: ['Classic Facial'], assign: 'manager',
    lead: { name: 'Kavita Joshi', phone: '9825010004', source: 'walk_in', gender: 'female', budgetPaise: 500000, dob: '1990-08-21',
      address: { line1: '22 Ghod Dod Road', city: 'Surat', state: 'Gujarat', pincode: '395001' }, notes: 'Bridal package enquiry, wedding on 12 Dec' },
    followUps: [
      { outcome: 'no_answer', next: -6 },
      { outcome: 'interested', note: 'Wants a trial session first', next: -3 },
      { channel: 'visit', outcome: 'interested', note: 'Came for the trial, liked it. Comparing with one more salon', next: 2 },
    ] },
  { as: 'branch', branch: 'TST1', services: [],
    lead: { name: 'Mohit Shah', phone: '9825010005', source: 'phone', gender: 'male' },
    followUps: [{ outcome: 'not_interested', note: 'Found the package too expensive', next: null }],
    then: { lost: 'Price too high' } },
  { as: 'branch', branch: 'TST1', services: ['Classic Facial'],
    lead: { name: 'Pooja Desai', phone: '9825010006', source: 'walk_in', gender: 'female', email: 'pooja.desai@example.com', dob: '1996-02-14', anniversary: '2022-11-27' },
    followUps: [
      { outcome: 'interested', next: -1 },
      { outcome: 'booked', note: 'Booked for Saturday 11 am', next: null },
    ],
    then: { convert: true } },
  { as: 'branch', branch: 'TST1', services: [],
    lead: { name: 'Arjun Nair', phone: '9825010007', source: 'walk_in', gender: 'male', email: 'arjun.nair@example.com', dob: '1988-06-03', anniversary: '2015-01-19',
      address: { line1: '9 Citylight Road', line2: 'Near Science Centre', city: 'Surat', state: 'Gujarat', pincode: '395007' }, budgetPaise: 80000 },
    notes: ['Prefers weekend appointments'] },
  { as: 'branch', branch: 'TST1', services: [],
    lead: { name: 'Deepa Iyer', phone: '9825010008', source: 'phone', gender: 'female' },
    followUps: [{ outcome: 'call_back', note: 'Asked to call next week', next: -5 }] },

  // Adajan (TST2), worked by branch2@glox.test
  { as: 'branch2', branch: 'TST2', services: ['Classic Facial'], due: 0,
    lead: { name: 'Nikita Rao', phone: '9825020001', source: 'walk_in', gender: 'female', notes: 'Wants a monthly membership' } },
  { as: 'branch2', branch: 'TST2', services: [],
    lead: { name: 'Varun Mehta', phone: '9825020002', source: 'whatsapp', gender: 'male' },
    followUps: [{ channel: 'whatsapp', outcome: 'interested', note: 'Sent the price list on WhatsApp', next: 1 }] },
  { as: 'branch2', branch: 'TST2', services: [],
    lead: { name: 'Isha Trivedi', phone: '9825020003', source: 'phone', gender: 'female' },
    followUps: [{ outcome: 'not_interested', next: null }],
    then: { lost: 'Moved to another city', reopen: true } },
  { as: 'branch2', branch: 'TST2', services: [], due: -1,
    lead: { name: 'Karan Malhotra', phone: '9825020004', source: 'walk_in', gender: 'male' } },
  // Owner adds one for Adajan and gives it to the manager covering both branches
  { as: 'owner', branch: 'TST2', services: ['Classic Facial'], due: 3, assign: 'manager2',
    lead: { name: 'Meera Bhatt', phone: '9825020005', source: 'phone', gender: 'female', budgetPaise: 350000, notes: 'Corporate group booking for 6 people' } },
];

function istDate(offsetDays: number) {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return ist.toISOString().slice(0, 10);
}

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

async function login(email: string) {
  return (await call(null, 'POST', '/auth/login', { email, password: PASSWORD })).accessToken as string;
}

async function main() {
  const tokens = {
    owner: await login('owner@glox.test'),
    branch: await login('branch@glox.test'),
    branch2: await login('branch2@glox.test'),
  };
  const branches: any[] = await call(tokens.owner, 'GET', '/business/branches/directory');
  const branchId = (code: string) => branches.find((b) => b.code === code)!._id as string;
  const services: any[] = await call(tokens.owner, 'GET', '/services');
  const serviceId = (name: string) => services.find((s) => s.name === name)?._id as string | undefined;
  const managers: any[] = await call(tokens.owner, 'GET', '/business/managers');
  const managerId = (email: string) => managers.find((m) => m.email === email)?._id as string;
  const existing = new Set(((await call(tokens.owner, 'GET', '/leads')) as any[]).map((l) => l.phone));

  let created = 0;
  for (const spec of SPECS) {
    const phone = `+91${spec.lead.phone}`;
    if (existing.has(phone)) {
      console.log(`exists   ${spec.lead.name} ${phone}`);
      continue;
    }
    const t = tokens[spec.as];
    const lead = await call(t, 'POST', '/leads', {
      ...spec.lead,
      branchId: branchId(spec.branch),
      serviceIds: spec.services.map(serviceId).filter(Boolean),
      ...(spec.due !== undefined ? { followUpDate: istDate(spec.due) } : {}),
      ...(spec.assign ? { assignedTo: managerId(`${spec.assign}@glox.test`) } : {}),
    });
    for (const f of spec.followUps ?? []) {
      await call(t, 'POST', `/leads/${lead._id}/follow-ups`, {
        channel: f.channel ?? 'call',
        outcome: f.outcome,
        ...(f.note ? { note: f.note } : {}),
        ...(f.next !== null && f.next !== undefined ? { nextFollowUpDate: istDate(f.next) } : {}),
      });
    }
    for (const text of spec.notes ?? []) await call(t, 'POST', `/leads/${lead._id}/notes`, { text });
    if (spec.then?.lost) await call(t, 'PATCH', `/leads/${lead._id}`, { stage: 'lost', lostReason: spec.then.lost });
    if (spec.then?.reopen) {
      await call(t, 'PATCH', `/leads/${lead._id}`, { stage: 'contacted', followUpDate: istDate(0) });
      await call(t, 'POST', `/leads/${lead._id}/notes`, { text: 'Called back: moving back to Surat next month, still interested' });
    }
    if (spec.then?.convert) await call(t, 'POST', `/leads/${lead._id}/convert`);

    const final = await call(t, 'GET', `/leads/${lead._id}`);
    console.log(
      `created  ${String(final.name).padEnd(16)} ${spec.branch} · ${final.stage.padEnd(10)} · ${final.followUps.length} follow-ups · ` +
        `next ${final.followUpDate ?? '—'}${final.customerId ? ' · converted' : ''}`
    );
    created++;
  }
  console.log(`\n${created} leads added. Today (IST) is ${istDate(0)}.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
