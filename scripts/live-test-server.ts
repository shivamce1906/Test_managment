/**
 * Live WhatsApp test backend, fully separate from Atlas and from the dev server on :4000.
 *
 *   - its own MongoDB (local, kept between runs in ~/.glox-live-test-db; pass --reset to start over)
 *   - seeds the test logins + sample data (owner@glox.test … password Test@1234)
 *   - the API on http://localhost:4100, Redis DB 5 (so its queues never mix with :4000's)
 *   - every raw Instant Broadcast event is logged (IB_LOG_RAW)
 *
 * With IB_TOKEN set it also connects the WhatsApp number to "Glox Test Salon" (branch TST1),
 * adds the approved template and adds TEST_PHONE as a customer:
 *
 *   IB_TOKEN='<instant broadcast api key>' WA_PHONE='+91…' TEST_PHONE='+917016620542' \
 *     npx tsx scripts/live-test-server.ts
 *
 * Or connect WhatsApp later, while it runs: the same variables plus `--connect`.
 * Point the frontend at it with VITE_API_BASE_URL=http://localhost:4100.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const PORT = 4100;
const API = `http://localhost:${PORT}`;
const DB_PATH = path.join(os.homedir(), '.glox-live-test-db');
const REDIS_URL = 'redis://localhost:6379/5';
const PASSWORD = 'Test@1234';
const TEMPLATE = {
  name: 'multivariable_text_template_321',
  category: 'utility',
  language: 'en',
  body: '{{1}} · {{2}} · {{3}} · {{4}}',
  variables: ['name', 'salon', 'detail', 'time'],
};

function run(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', ...args], { stdio: 'inherit', env });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args[0]} exited with ${code}`))));
  });
}

async function call(method: string, url: string, token?: string, body?: unknown) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

async function waitForApi() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${API}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('API did not start on :4100');
}

/** Connects the number through the Super Admin API, then adds what the API can't (template, customer). */
async function connectWhatsapp(uri: string) {
  const token = process.env.IB_TOKEN!;
  const uid = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).uid as string;
  const waPhone = process.env.WA_PHONE;
  if (!waPhone) throw new Error('WA_PHONE (the salon\'s WhatsApp number) is required with IB_TOKEN');

  const conn = await mongoose.createConnection(uri).asPromise();
  const db = conn.db!;
  const business = await db.collection('businesses').findOne({ name: 'Glox Test Salon' });
  const branch = await db.collection('branches').findOne({ businessId: business!._id, code: 'TST1' });

  const admin = await call('POST', '/auth/login', undefined, { email: 'superadmin@glox.test', password: PASSWORD });
  const cfg = await call('POST', `/admin/businesses/${business!._id}/wa-config`, admin.accessToken, {
    phone: waPhone, uid, userToken: token, branchIds: [String(branch!._id)],
  });
  const number = cfg.data ?? cfg;
  console.log(`\nWhatsApp ${waPhone} connected (uid ${uid}) → Glox Test Salon / Test Branch`);
  console.log(`Webhook path (needs a public tunnel to use): ${number.webhookUrl}`);

  const now = new Date();
  await db.collection('watemplates').updateOne(
    { businessId: business!._id, numberId: new mongoose.Types.ObjectId(String(number._id)), name: TEMPLATE.name },
    { $set: { ...TEMPLATE, status: 'approved', syncedAt: now, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  console.log(`Template ${TEMPLATE.name} (4 variables) is approved for sending`);

  const testPhone = process.env.TEST_PHONE;
  if (testPhone) {
    const owner = await call('POST', '/auth/login', undefined, { email: 'owner@glox.test', password: PASSWORD });
    try {
      await call('POST', '/customers', owner.accessToken, { name: 'Live Test Customer', phone: testPhone, source: 'whatsapp' });
      console.log(`Customer "Live Test Customer" ${testPhone} added`);
    } catch (err) {
      console.log(`Customer ${testPhone}: ${(err as Error).message.includes('409') ? 'already exists' : (err as Error).message}`);
    }
  }
  await conn.close();
}

let replSet: MongoMemoryReplSet | null = null;

async function main() {
  // Connect WhatsApp to a test backend that is already running (the database port is fixed)
  if (process.argv.includes('--connect')) {
    if (!process.env.IB_TOKEN) throw new Error('IB_TOKEN is required with --connect');
    await connectWhatsapp('mongodb://127.0.0.1:27118/glox_live_test?directConnection=true');
    process.exit(0);
  }
  if (process.argv.includes('--reset')) fs.rmSync(DB_PATH, { recursive: true, force: true });
  fs.mkdirSync(DB_PATH, { recursive: true });

  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    // A fixed port: the saved replica-set config names it, so a restart finds its primary again
    instanceOpts: [{ dbPath: DB_PATH, port: 27118 }],
  });
  const uri = replSet.getUri('glox_live_test');
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):/.test(uri)) throw new Error(`Refusing non-local database ${uri}`);
  console.log(`Local database ${uri} (files in ${DB_PATH})`);

  const env: NodeJS.ProcessEnv = { ...process.env, MONGODB_URI: uri, PORT: String(PORT), REDIS_URL, IB_LOG_RAW: 'true' };
  // Never hand the IB key to the child processes' environment beyond what they need
  delete env.IB_TOKEN;

  await run(['scripts/seed-test-logins.ts'], env);
  await run(['scripts/seed-sample-data.ts'], env);

  const server = spawn('npx', ['tsx', 'src/server.ts'], { stdio: 'inherit', env });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const exited = server.exitCode !== null ? Promise.resolve() : new Promise((r) => server.once('exit', r));
    server.kill('SIGINT');
    // Don't hang on a child that is already gone or slow to close
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    await Promise.race([replSet?.stop({ doCleanup: false }), new Promise((r) => setTimeout(r, 15_000))]);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await waitForApi();
  if (process.env.IB_TOKEN) await connectWhatsapp(uri);

  console.log(`\nReady: API ${API} · logins owner@ / manager@ / manager2@ / branch@ / branch2@ / superadmin@glox.test · password ${PASSWORD}`);
  console.log('Frontend: VITE_API_BASE_URL=http://localhost:4100 npm run dev   ·   Ctrl+C here stops everything\n');
}

main().catch(async (err) => {
  console.error(err);
  await replSet?.stop({ doCleanup: false }).catch(() => undefined);
  process.exit(1);
});
