import '../src/config/env';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types } from 'mongoose';
import { disconnectRedis } from '../src/integrations';
import { Business, Branch, User, IBusiness, IBranch, IUser } from '../src/models';
import { hashPassword } from '../src/utils';

let replSet: MongoMemoryReplSet | null = null;

export async function setupTestDb(): Promise<string> {
  if (!replSet) {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    const uri = replSet.getUri();
    await mongoose.connect(uri);
    return uri;
  }
  return replSet.getUri();
}

export async function clearTestDb(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  }
}

export async function teardownTestDb(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (replSet) {
    await replSet.stop();
    replSet = null;
  }
  await disconnectRedis();
}

export async function createTestBusiness(overrides: Partial<IBusiness> = {}) {
  return Business.create({
    name: 'Test Salon Spa',
    address: {
      line1: '123 MG Road',
      city: 'Bangalore',
      state: 'Karnataka',
      pincode: '560001',
    },
    gst: {
      enabled: true,
      rateBps: 1800,
      sac: '999721',
      pricesInclusive: false,
    },
    fyStartMonth: 4,
    discountLimits: {
      managerBps: 2000,
      branchBps: 1000,
      ownerAlertBps: 3000,
    },
    dayEndReportTime: '23:00',
    loyalty: { enabled: true },
    payroll: {
      pf: { enabled: false },
      esi: { enabled: false },
      pt: { enabled: false },
    },
    automationGuards: {
      quietStart: '21:00',
      quietEnd: '09:00',
      maxMarketingPerDay: 2,
    },
    ownerWhatsappPhone: '+919876543210',
    status: 'active',
    ...overrides,
  });
}

export async function createTestBranch(businessId: Types.ObjectId | string, overrides: Partial<IBranch> = {}) {
  const code = overrides.code || 'MBR';
  return Branch.create({
    businessId,
    name: 'Main Branch',
    code,
    invoicePrefix: overrides.invoicePrefix || code,
    phone: '+919876543211',
    address: {
      line1: '456 Brigade Road',
      city: 'Bangalore',
      state: 'Karnataka',
      pincode: '560025',
    },
    pettyCashFloatPaise: 500000,
    status: 'active',
    ...overrides,
  });
}

export async function createTestUser(businessId: Types.ObjectId | string, overrides: Partial<IUser> = {}) {
  const password = (overrides as any).password || 'Secret123!';
  const passwordHash = await hashPassword(password);

  return User.create({
    businessId,
    name: 'Test User',
    email: `user_${Date.now()}_${Math.random().toString(36).substring(2, 6)}@test.com`,
    passwordHash,
    role: 'owner',
    status: 'active',
    sessionVersion: 1,
    failedLogins: 0,
    ...overrides,
  });
}
