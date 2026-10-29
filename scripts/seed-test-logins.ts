/**
 * Seeds one login per role for manual testing:
 *   superadmin@glox.test, owner@glox.test, manager@glox.test, branch@glox.test
 * all with password Test@1234, inside a "Glox Test Salon" business with one branch.
 *
 * Writes straight through the models (the onboarding APIs are broken, see
 * docs/TEST_FAILURES_REPORT.md #9). Safe to re-run: existing records are reused.
 *
 *   npx tsx scripts/seed-test-logins.ts
 */
import '../src/config/env';
import mongoose from 'mongoose';
import { connectDb, disconnectDb, env } from '../src/config';
import { Business, Branch, User, PlatformAdmin, EmailRegistry } from '../src/models';
import { hashPassword } from '../src/utils';

const PASSWORD = 'Test@1234';
const BUSINESS_NAME = 'Glox Test Salon';
const address = { line1: '12 MG Road', city: 'Surat', state: 'Gujarat', pincode: '395007' };

async function main() {
  await connectDb(env.MONGODB_URI);
  console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name}`);
  const passwordHash = await hashPassword(PASSWORD);

  // Super admin
  const adminEmail = 'superadmin@glox.test';
  let admin = await PlatformAdmin.findOne({ email: adminEmail });
  if (!admin) {
    admin = await PlatformAdmin.create({ name: 'Test Super Admin', email: adminEmail, passwordHash });
    console.log(`created  ${adminEmail}`);
  } else {
    console.log(`exists   ${adminEmail}`);
  }
  await EmailRegistry.updateOne(
    { _id: adminEmail },
    { $setOnInsert: { kind: 'platform', userId: admin._id } },
    { upsert: true }
  );

  // Business + branch
  let business = await Business.findOne({ name: BUSINESS_NAME });
  if (!business) {
    business = await Business.create({
      name: BUSINESS_NAME,
      address,
      gst: { enabled: false, rateBps: 1800, sac: '9983', pricesInclusive: false },
      ownerWhatsappPhone: '+919800000001',
      status: 'active',
    });
    console.log(`created  business "${BUSINESS_NAME}"`);
  }
  const businessId = business._id;

  let branch = await Branch.findOne({ businessId, code: 'TST1' });
  if (!branch) {
    branch = await Branch.create({
      businessId,
      name: 'Test Branch',
      code: 'TST1',
      invoicePrefix: 'TST1',
      phone: '+919800000002',
      address,
      pettyCashFloatPaise: 500000,
      status: 'active',
    });
    console.log('created  branch TST1');
  }

  // Tenant users
  const tenantUsers = [
    { email: 'owner@glox.test', role: 'owner', name: 'Test Owner', branchIds: [] as any[] },
    {
      email: 'manager@glox.test',
      role: 'manager',
      name: 'Test Manager',
      branchIds: [branch._id],
      flags: { manageStaff: true, approvePO: true, viewPayroll: true, editBranchPrices: true },
    },
    {
      email: 'branch@glox.test',
      role: 'branch',
      name: 'Test Branch Login',
      branchIds: [branch._id],
      branchLoginFor: branch._id,
    },
  ];

  for (const spec of tenantUsers) {
    let user = await User.findOne({ email: spec.email }, null, { skipTenantScope: true });
    if (!user) {
      user = await User.create({ businessId, passwordHash, status: 'active', ...spec });
      console.log(`created  ${spec.email}`);
    } else {
      console.log(`exists   ${spec.email}`);
    }
    await EmailRegistry.updateOne(
      { _id: spec.email },
      { $setOnInsert: { kind: 'tenant', businessId: user.businessId, userId: user._id } },
      { upsert: true }
    );
  }

  console.log(`\nPassword for all accounts: ${PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
