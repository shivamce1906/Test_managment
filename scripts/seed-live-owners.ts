/**
 * Adds two separate salon owners to the RUNNING live-test backend (:4100), each with one branch
 * and its own Instant Broadcast (WhatsApp) account:
 *
 *   Live Salon A → owner-a@glox.test, branch LVA1 (login branch-a@glox.test)
 *   Live Salon B → owner-b@glox.test, branch LVB1 (login branch-b@glox.test)
 *
 * Password for all four: Test@1234. Onboarding goes through the Super Admin API
 * (POST /admin/businesses), so it exercises the same path the admin dashboard uses.
 *
 * The keys are read from the environment only. Type them in the terminal; never put them in a
 * file or a commit. The account id (uid) is read from the key itself.
 *
 *   OWNER_A_IB_TOKEN='<key A>' OWNER_A_WA_PHONE='+91…' \
 *   OWNER_B_IB_TOKEN='<key B>' OWNER_B_WA_PHONE='+91…' \
 *     npx tsx scripts/seed-live-owners.ts
 *
 * Safe to re-run: an existing business is reused and its WhatsApp config is updated.
 * Leave out an owner's token to create that owner without connecting WhatsApp.
 */
const API = process.env.LIVE_API_URL ?? 'http://localhost:4100';
const PASSWORD = 'Test@1234';

type OwnerSpec = {
  key: 'A' | 'B';
  business: string;
  ownerName: string;
  ownerEmail: string;
  branchName: string;
  branchCode: string;
  branchEmail: string;
  city: string;
  pincode: string;
};

const OWNERS: OwnerSpec[] = [
  {
    key: 'A',
    business: 'Live Salon A',
    ownerName: 'Live Owner A',
    ownerEmail: 'owner-a@glox.test',
    branchName: 'Live A Main',
    branchCode: 'LVA1',
    branchEmail: 'branch-a@glox.test',
    city: 'Surat',
    pincode: '395007',
  },
  {
    key: 'B',
    business: 'Live Salon B',
    ownerName: 'Live Owner B',
    ownerEmail: 'owner-b@glox.test',
    branchName: 'Live B Main',
    branchCode: 'LVB1',
    branchEmail: 'branch-b@glox.test',
    city: 'Ahmedabad',
    pincode: '380009',
  },
];

async function call(method: string, url: string, token?: string, body?: unknown) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json.data ?? json;
}

function uidOf(token: string) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).uid as string;
  } catch {
    throw new Error('That Instant Broadcast key is not a valid token (expected three dot-separated parts)');
  }
}

/** "+91 99333 36004" / "9933336004" → "+919933336004". */
function phone(raw: string) {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 10 ? `+91${digits}` : `+${digits}`;
}

async function findBusiness(admin: string, name: string) {
  const { businesses } = await call('GET', `/admin/businesses?q=${encodeURIComponent(name)}&limit=10`, admin);
  return (businesses as any[]).find((b) => b.name === name);
}

async function ensureOwner(admin: string, spec: OwnerSpec, waPhone?: string) {
  const existing = await findBusiness(admin, spec.business);
  if (existing) {
    console.log(`exists   ${spec.business} (${spec.ownerEmail})`);
    const detail = await call('GET', `/admin/businesses/${existing._id}`, admin);
    const branches: any[] = detail.branches ?? [];
    const branch = branches.find((b) => b.code === spec.branchCode) ?? branches[0];
    return { businessId: String(existing._id), branchId: String(branch._id) };
  }
  const address = { line1: `${spec.key} Test Road`, city: spec.city, state: 'Gujarat', pincode: spec.pincode };
  const created = await call('POST', '/admin/businesses', admin, {
    business: {
      name: spec.business,
      address,
      gst: { enabled: false, rateBps: 1800, sac: '9983', pricesInclusive: false },
      fyStartMonth: 4,
      discountLimits: { managerBps: 2000, branchBps: 1000, ownerAlertBps: 2500 },
      dayEndReportTime: '23:00',
      // Day-end reports go here; kept off the salon's own WhatsApp number on purpose.
      ownerWhatsappPhone: spec.key === 'A' ? '+919800000011' : '+919800000012',
    },
    owner: { name: spec.ownerName, email: spec.ownerEmail, password: PASSWORD },
    headBranch: {
      name: spec.branchName,
      code: spec.branchCode,
      invoicePrefix: spec.branchCode,
      address,
      phone: waPhone ?? (spec.key === 'A' ? '+919800000021' : '+919800000022'),
      loginEmail: spec.branchEmail,
      loginPassword: PASSWORD,
    },
  });
  console.log(`created  ${spec.business}: ${spec.ownerEmail}, branch ${spec.branchCode} (${spec.branchEmail})`);
  return { businessId: String(created.business._id), branchId: String(created.branch._id) };
}

async function main() {
  if ((await fetch(`${API}/health`).catch(() => null))?.ok !== true) {
    throw new Error(`Live-test backend not reachable at ${API}. Start it first: npx tsx scripts/live-test-server.ts`);
  }
  const { accessToken: admin } = await call('POST', '/auth/login', undefined, {
    email: 'superadmin@glox.test',
    password: PASSWORD,
  });

  const uids = new Set<string>();
  for (const spec of OWNERS) {
    const token = process.env[`OWNER_${spec.key}_IB_TOKEN`];
    const rawPhone = process.env[`OWNER_${spec.key}_WA_PHONE`];
    if (token && !rawPhone) throw new Error(`OWNER_${spec.key}_WA_PHONE is required with OWNER_${spec.key}_IB_TOKEN`);
    const waPhone = rawPhone ? phone(rawPhone) : undefined;

    const { businessId, branchId } = await ensureOwner(admin, spec, waPhone);
    if (!token) {
      console.log(`skipped  WhatsApp for ${spec.business} (no OWNER_${spec.key}_IB_TOKEN)`);
      continue;
    }
    const uid = uidOf(token);
    if (uids.has(uid)) throw new Error('Both owners were given the same Instant Broadcast account; each needs its own');
    uids.add(uid);

    const number = await call('POST', `/admin/businesses/${businessId}/wa-config`, admin, {
      phone: waPhone,
      uid,
      userToken: token,
      branchIds: [branchId],
    });
    console.log(`WhatsApp ${waPhone} (account ${uid}) → ${spec.business} / ${spec.branchCode}`);
    if (number.webhookUrl) console.log(`         webhook path: ${number.webhookUrl}`);
  }

  console.log(`\nPassword for owner-a@ / branch-a@ / owner-b@ / branch-b@glox.test: ${PASSWORD}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
