import './testEnv';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../../src/app';
import {
  Business,
  Branch,
  User,
  PlatformAdmin,
  EmailRegistry,
  Staff,
  Category,
  Service,
  Product,
  Customer,
  Plan,
  StockBalance,
  Roster,
} from '../../src/models';
import { AuthService } from '../../src/services';
import { getBusinessDate, parseIstDateTime } from '../../src/utils';

export const PASSWORD = 'Secret123';
// Low bcrypt cost keeps fixtures fast; verifyPassword works with any cost.
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

export const app = createApp();
const auth = new AuthService();

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export function tokenFor(user: { _id: any; role: string; businessId?: any; sessionVersion?: number }): string {
  return auth.generateAccessToken({
    sub: user._id.toString(),
    kind: 'tenant',
    role: user.role as any,
    businessId: user.businessId?.toString(),
    sv: user.sessionVersion ?? 0,
  });
}

export function platformToken(admin: { _id: any; sessionVersion?: number }): string {
  return auth.generateAccessToken({
    sub: admin._id.toString(),
    kind: 'platform',
    role: 'superadmin',
    sv: admin.sessionVersion ?? 0,
  });
}

/** Supertest agent with a bearer token pre-applied. */
export function as(token?: string) {
  const withAuth = (r: request.Test) => (token ? r.set('Authorization', `Bearer ${token}`) : r);
  return {
    get: (url: string) => withAuth(request(app).get(url)),
    post: (url: string, body?: any) => withAuth(request(app).post(url)).send(body ?? {}),
    patch: (url: string, body?: any) => withAuth(request(app).patch(url)).send(body ?? {}),
    put: (url: string, body?: any) => withAuth(request(app).put(url)).send(body ?? {}),
    delete: (url: string) => withAuth(request(app).delete(url)),
  };
}

export const address = { line1: '12 MG Road', city: 'Surat', state: 'Gujarat', pincode: '395007' };

export async function createPlatformAdmin(overrides: any = {}) {
  const email = overrides.email || `admin_${uniq()}@glox.test`;
  const admin = await PlatformAdmin.create({ name: 'Glox Admin', email, passwordHash: PASSWORD_HASH, ...overrides });
  await EmailRegistry.create({ _id: email.toLowerCase(), kind: 'platform', userId: admin._id });
  return admin;
}

export async function createBusiness(overrides: any = {}) {
  return Business.create({
    name: 'Glamour Studio',
    address,
    gst: { enabled: true, rateBps: 1800, sac: '9983', pricesInclusive: false, gstin: '24AAAAA0000A1Z5', pan: 'AAAAA0000A' },
    fyStartMonth: 4,
    discountLimits: { managerBps: 2000, branchBps: 1000, ownerAlertBps: 2500 },
    dayEndReportTime: '23:00',
    loyalty: { enabled: true, earnPer100: 1, redeemValuePaise: 100, minRedeem: 10, expiryDays: 365 },
    payroll: { pf: { enabled: false }, esi: { enabled: false }, pt: { enabled: false } },
    automationGuards: { quietStart: '21:00', quietEnd: '09:00', maxMarketingPerDay: 1 },
    ownerWhatsappPhone: '+919800000001',
    status: 'active',
    ...overrides,
  });
}

export async function createBranch(businessId: Types.ObjectId, overrides: any = {}) {
  const code = overrides.code || `B${uniq().toUpperCase().slice(-5)}`;
  return Branch.create({
    businessId,
    name: overrides.name || `Branch ${code}`,
    code,
    invoicePrefix: overrides.invoicePrefix || code,
    phone: '+919800000002',
    address,
    pettyCashFloatPaise: 500000,
    status: 'active',
    ...overrides,
  });
}

export async function createUser(businessId: Types.ObjectId, overrides: any = {}) {
  const email = overrides.email || `${overrides.role || 'owner'}_${uniq()}@salon.test`;
  const user = await User.create({
    businessId,
    name: overrides.name || `${overrides.role || 'owner'} user`,
    email,
    passwordHash: PASSWORD_HASH,
    role: 'owner',
    branchIds: [],
    status: 'active',
    sessionVersion: 0,
    failedLogins: 0,
    ...overrides,
  });
  await EmailRegistry.create({ _id: email.toLowerCase(), kind: 'tenant', businessId, userId: user._id });
  return user;
}

export async function createStaff(businessId: Types.ObjectId, branchId: Types.ObjectId, overrides: any = {}) {
  return Staff.create({
    businessId,
    branchId,
    name: overrides.name || `Staff ${uniq()}`,
    phone: '+919811111111',
    designation: 'stylist',
    joiningDate: '2025-04-01',
    serviceIds: [],
    salary: { type: 'monthly', amountPaise: 3000000 },
    statutory: { pf: false, esi: false, pt: false },
    status: 'active',
    ...overrides,
  });
}

export async function createCustomer(businessId: Types.ObjectId, overrides: any = {}) {
  const digits = String(9000000000 + Math.floor(Math.random() * 999999999)).slice(0, 10);
  return Customer.create({
    businessId,
    name: overrides.name || 'Priya Shah',
    phone: overrides.phone || `+91${digits}`,
    source: 'walk_in',
    tags: [],
    waOptIn: true,
    doNotMessage: false,
    stats: { visits: 0, spendPaise: 0, noShows: 0 },
    walletBalancePaise: 0,
    loyaltyPoints: 0,
    duePaise: 0,
    ...overrides,
  });
}

/**
 * A complete salon: business (GST on), two branches, owner, manager of branch A,
 * branch logins for A and B, receptionist + two stylists in A, one stylist in B,
 * catalogue (category, haircut ₹1,000/30min, colour ₹2,500/90min with consumable),
 * retail + consumable products with opening stock, a customer, and a second
 * unrelated business for tenant-isolation checks.
 */
export async function seedWorld(opts: { gst?: boolean; managerFlags?: any; branchLoginFlags?: any } = {}) {
  const business = await createBusiness({
    gst: opts.gst === false
      ? { enabled: false, rateBps: 1800, sac: '9983', pricesInclusive: false }
      : { enabled: true, rateBps: 1800, sac: '9983', pricesInclusive: false, gstin: '24AAAAA0000A1Z5', pan: 'AAAAA0000A' },
  });
  const branchA = await createBranch(business._id, { code: 'SRT1', invoicePrefix: 'SRT1', name: 'Vesu' });
  const branchB = await createBranch(business._id, { code: 'SRT2', invoicePrefix: 'SRT2', name: 'Adajan' });

  const owner = await createUser(business._id, { role: 'owner', name: 'Owner Olivia' });
  const manager = await createUser(business._id, {
    role: 'manager',
    name: 'Manager Meera',
    branchIds: [branchA._id],
    flags: { manageStaff: true, approvePO: true, viewPayroll: true, editBranchPrices: true, ...(opts.managerFlags || {}) },
  });
  const branchLoginA = await createUser(business._id, {
    role: 'branch',
    name: 'Vesu Login',
    branchIds: [branchA._id],
    branchLoginFor: branchA._id,
    flags: { markAttendance: false, ...(opts.branchLoginFlags || {}) },
  });
  const branchLoginB = await createUser(business._id, {
    role: 'branch',
    name: 'Adajan Login',
    branchIds: [branchB._id],
    branchLoginFor: branchB._id,
  });

  const receptionist = await createStaff(business._id, branchA._id, { name: 'Riya Reception', designation: 'receptionist' });
  const stylist1 = await createStaff(business._id, branchA._id, {
    name: 'Sam Stylist',
    commission: { service: { type: 'pct', value: 1000 }, productBps: 500, overtimePerHourPaise: 10000 },
  });
  const stylist2 = await createStaff(business._id, branchA._id, { name: 'Tara Stylist' });
  const stylistB = await createStaff(business._id, branchB._id, { name: 'Bina Stylist' });

  const category = await Category.create({ businessId: business._id, name: 'Hair', gender: 'unisex', order: 1, active: true });

  const consumable = await Product.create({
    businessId: business._id,
    name: 'Colour Tube',
    type: 'consumable',
    purchaseUnit: 'tube',
    useUnit: 'ml',
    unitsPerPurchase: 100,
    purchasePricePaise: 50000,
    active: true,
  });
  const retail = await Product.create({
    businessId: business._id,
    name: 'Argan Shampoo',
    type: 'retail',
    purchaseUnit: 'bottle',
    useUnit: 'bottle',
    unitsPerPurchase: 1,
    mrpPaise: 60000,
    sellingPricePaise: 50000,
    purchasePricePaise: 30000,
    hsn: '3305',
    gstBps: 1800,
    active: true,
  });

  const haircut = await Service.create({
    businessId: business._id,
    categoryId: category._id,
    name: 'Haircut',
    gender: 'unisex',
    basePricePaise: 100000,
    durationMin: 30,
    commission: { type: 'pct', value: 1000 },
    active: true,
  });
  const colour = await Service.create({
    businessId: business._id,
    categoryId: category._id,
    name: 'Global Colour',
    gender: 'women',
    basePricePaise: 250000,
    durationMin: 90,
    consumables: [{ productId: consumable._id, qty: 30 }],
    active: true,
  });

  await StockBalance.create({ businessId: business._id, branchId: branchA._id, productId: retail._id, pool: 'retail', qty: 10, lastMovementAt: new Date() });
  await StockBalance.create({ businessId: business._id, branchId: branchA._id, productId: consumable._id, pool: 'consumable', qty: 500, lastMovementAt: new Date() });

  const customer = await createCustomer(business._id, { name: 'Priya Shah', phone: '+919876543210' });

  // Unrelated tenant
  const otherBusiness = await createBusiness({ name: 'Rival Salon' });
  const otherBranch = await createBranch(otherBusiness._id, { code: 'RIV1', invoicePrefix: 'RIV1' });
  const otherOwner = await createUser(otherBusiness._id, { role: 'owner', name: 'Rival Owner' });
  const otherCustomer = await createCustomer(otherBusiness._id, { name: 'Rival Customer', phone: '+919999999999' });

  return {
    business, branchA, branchB, owner, manager, branchLoginA, branchLoginB,
    receptionist, stylist1, stylist2, stylistB, category, haircut, colour, consumable, retail, customer,
    otherBusiness, otherBranch, otherOwner, otherCustomer,
    tokens: {
      owner: tokenFor(owner),
      manager: tokenFor(manager),
      branchA: tokenFor(branchLoginA),
      branchB: tokenFor(branchLoginB),
      otherOwner: tokenFor(otherOwner),
    },
  };
}

export type World = Awaited<ReturnType<typeof seedWorld>>;

export async function createPlan(businessId: Types.ObjectId, overrides: any = {}) {
  return Plan.create({ businessId, name: 'Plan', pricePaise: 100000, validityDays: 365, branchScope: [], active: true, ...overrides });
}

export async function createRoster(world: World, staffId: Types.ObjectId, weekly: any[], overrides: any[] = []) {
  return Roster.create({ businessId: world.business._id, branchId: world.branchA._id, staffId, weekly, overrides });
}

/** IST business date N days from today. */
export function dayOffset(days: number): string {
  return getBusinessDate(new Date(Date.now() + days * 86400000));
}

/** ISO string for HH:mm IST on the given business date. */
export function ist(businessDate: string, hhmm: string): string {
  return parseIstDateTime(businessDate, hhmm).toISOString();
}

export function serviceLine(serviceId: any, staffId?: any, extra: any = {}) {
  return {
    kind: 'service',
    refId: serviceId.toString(),
    qty: 1,
    ...(staffId ? { staff: [{ staffId: staffId.toString(), splitBps: 10000 }] } : {}),
    ...extra,
  };
}
