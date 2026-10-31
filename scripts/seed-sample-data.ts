/**
 * Fills "Glox Test Salon" (created by seed-test-logins.ts) with sample data for the owner screens:
 * a second branch with its own login, categories, products with opening stock, services (with a
 * branch price override), staff with default rosters, and customers.
 *
 * Everything goes through the app's services, so validation, phone normalisation, rosters and
 * audit entries behave exactly as from the UI. Safe to re-run: records that exist are skipped.
 * Only "Glox Test Salon" is touched.
 *
 *   npx tsx scripts/seed-test-logins.ts   (first, once)
 *   npx tsx scripts/seed-sample-data.ts
 */
import '../src/config/env';
import mongoose from 'mongoose';
import { connectDb, disconnectDb, env } from '../src/config';
import { Appointment, Business, Branch, Category, Customer, Expense, PayrollRun, Plan, PlatformAdmin, Product, PurchaseOrder, Service, Staff, StockBalance, User, Vendor } from '../src/models';
import {
  RequestContext,
  adjustStock,
  appointmentService,
  billingService,
  businessService,
  catalogueService,
  createExpense,
  createPlan,
  createPurchaseOrder,
  createStaff,
  customerService,
  createMonthlyRun,
} from '../src/services';
import { addDays, getBusinessDate, parseIstDateTime } from '../src/utils';
import { useMockRedis } from '../src/integrations';

const BUSINESS_NAME = 'Glox Test Salon';
const address = { line1: '12 MG Road', city: 'Surat', state: 'Gujarat', pincode: '395007' };

const log = (verb: 'created' | 'exists ', what: string) => console.log(`${verb}  ${what}`);

async function main() {
  // Change counters etc. go to an in-memory Redis: the seed needs no live Redis
  useMockRedis();
  await connectDb(env.MONGODB_URI);
  console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name}`);

  const business = await Business.findOne({ name: BUSINESS_NAME });
  const owner = business && (await User.findOne({ businessId: business._id, role: 'owner' }));
  const admin = await PlatformAdmin.findOne({ email: 'superadmin@glox.test' });
  if (!business || !owner || !admin) {
    throw new Error('Run scripts/seed-test-logins.ts first');
  }
  const businessId = business._id;

  const ownerCtx: RequestContext = {
    userId: owner._id.toString(), businessId: businessId.toString(), role: 'owner', kind: 'tenant',
    name: owner.name, email: owner.email, branchIds: [],
  };
  const adminCtx: RequestContext = {
    userId: admin._id.toString(), role: 'super_admin', kind: 'platform', name: admin.name, branchIds: [],
  };

  // Branches: TST1 exists; make it the head branch, add TST2 with its own login
  const branch1 = await Branch.findOne({ businessId, code: 'TST1' });
  if (!branch1) throw new Error('Branch TST1 missing; run scripts/seed-test-logins.ts first');
  if (!business.headBranchId) {
    business.headBranchId = branch1._id;
    await business.save();
    log('created', 'head branch = TST1');
  }
  let branch2: { _id: mongoose.Types.ObjectId } | null = await Branch.findOne({ businessId, code: 'TST2' });
  if (!branch2) {
    const res = await businessService.createBranchByAdmin(adminCtx, businessId.toString(), {
      name: 'Adajan', code: 'TST2', invoicePrefix: 'TST2', phone: '+919800000003',
      address: { line1: '5 Ring Road', city: 'Surat', state: 'Gujarat', pincode: '395009' },
      loginEmail: 'branch2@glox.test', loginPassword: 'Test@1234', stations: 6, pettyCashFloatPaise: 500000,
    });
    branch2 = res.branch as { _id: mongoose.Types.ObjectId };
    log('created', 'branch TST2 Adajan (login branch2@glox.test)');
  } else {
    log('exists ', 'branch TST2');
  }

  // Categories (Hair > Colour is a sub-category)
  const category = async (name: string, gender: 'men' | 'women' | 'unisex', order: number, parentId?: string) => {
    const found = await Category.findOne({ businessId, name });
    if (found) return (log('exists ', `category ${name}`), found);
    log('created', `category ${name}`);
    return catalogueService.createCategory(ownerCtx, { name, gender, order, parentId });
  };
  const hair = await category('Hair', 'unisex', 1);
  const colour = await category('Colour', 'unisex', 1, hair._id.toString());
  const skin = await category('Skin', 'unisex', 2);
  const nails = await category('Nails', 'women', 3);

  // Products + opening stock in both branches
  const product = async (data: any, stock: number) => {
    let found: { _id: mongoose.Types.ObjectId } | null = await Product.findOne({ businessId, name: data.name });
    if (found) log('exists ', `product ${data.name}`);
    else {
      found = await catalogueService.createProduct(ownerCtx, { active: true, ...data });
      log('created', `product ${data.name}`);
    }
    const pool = data.type === 'consumable' ? 'consumable' : 'retail';
    for (const branch of [branch1, branch2!]) {
      if (!(await StockBalance.exists({ businessId, branchId: branch._id, productId: found._id, pool }))) {
        await adjustStock(ownerCtx, branch._id, { productId: found._id.toString(), pool, qty: stock, reason: 'Opening stock', type: 'adjust' });
      }
    }
    return found;
  };
  await product({ name: 'Argan Shampoo', brand: 'Moroccan', type: 'retail', purchaseUnit: 'bottle', useUnit: 'bottle', unitsPerPurchase: 1, mrpPaise: 60000, sellingPricePaise: 50000, purchasePricePaise: 30000, hsn: '3305', gstBps: 1800 }, 20);
  const colourTube = await product({ name: 'Colour Tube', brand: 'L’Oréal', type: 'consumable', purchaseUnit: 'tube', useUnit: 'ml', unitsPerPurchase: 100, purchasePricePaise: 50000 }, 1000);

  // Services
  const service = async (data: any) => {
    const found = await Service.findOne({ businessId, name: data.name });
    if (found) return (log('exists ', `service ${data.name}`), found);
    log('created', `service ${data.name}`);
    return catalogueService.createService(ownerCtx, { active: true, ...data });
  };
  const haircutWomen = await service({ categoryId: hair._id.toString(), name: 'Haircut (Women)', gender: 'women', basePricePaise: 60000, durationMin: 45, commission: { type: 'pct', value: 1000 }, rebookDays: 45 });
  await service({ categoryId: hair._id.toString(), name: 'Haircut (Men)', gender: 'men', basePricePaise: 30000, durationMin: 30, commission: { type: 'pct', value: 1000 }, rebookDays: 30 });
  await service({ categoryId: hair._id.toString(), name: 'Hair Spa', gender: 'unisex', basePricePaise: 120000, durationMin: 60 });
  await service({ categoryId: colour._id.toString(), name: 'Global Colour', gender: 'women', basePricePaise: 250000, durationMin: 90, consumables: [{ productId: colourTube._id.toString(), qty: 30 }] });
  await service({ categoryId: skin._id.toString(), name: 'Classic Facial', gender: 'unisex', basePricePaise: 150000, durationMin: 60 });
  await service({ categoryId: nails._id.toString(), name: 'Manicure', gender: 'women', basePricePaise: 50000, durationMin: 40 });
  if (!haircutWomen.branchPrices.some((bp) => bp.branchId.equals(branch2!._id))) {
    await catalogueService.setBranchPrice(ownerCtx, haircutWomen._id.toString(), { branchId: branch2._id.toString(), pricePaise: 65000 });
    log('created', 'branch price Haircut (Women) @ TST2 = ₹650');
  }

  // Staff (createStaff also creates the default roster)
  const staff = async (branchId: mongoose.Types.ObjectId, data: any) => {
    if (await Staff.exists({ businessId, name: data.name })) return log('exists ', `staff ${data.name}`);
    await createStaff(ownerCtx, {
      branchId: branchId.toString(), joiningDate: '2026-04-01', serviceIds: [], documents: [], status: 'active',
      statutory: { pf: false, esi: false, pt: false }, ...data,
    });
    log('created', `staff ${data.name}`);
  };
  await staff(branch1._id, { name: 'Riya Mehta', phone: '9811100001', designation: 'receptionist', salary: { type: 'monthly', amountPaise: 1800000 } });
  await staff(branch1._id, { name: 'Sameer Khan', phone: '9811100002', designation: 'senior_stylist', salary: { type: 'monthly', amountPaise: 3500000 }, commission: { service: { type: 'pct', value: 1000 }, productBps: 500 } });
  await staff(branch1._id, { name: 'Tara Patel', phone: '9811100003', designation: 'stylist', salary: { type: 'monthly', amountPaise: 2500000 }, commission: { service: { type: 'pct', value: 800 } } });
  await staff(branch1._id, { name: 'Neha Joshi', phone: '9811100004', designation: 'beautician', salary: { type: 'monthly', amountPaise: 2200000 } });
  await staff(branch2._id, { name: 'Kavya Shah', phone: '9811100005', designation: 'receptionist', salary: { type: 'monthly', amountPaise: 1800000 } });
  await staff(branch2._id, { name: 'Arjun Desai', phone: '9811100006', designation: 'stylist', salary: { type: 'monthly', amountPaise: 2500000 }, commission: { service: { type: 'pct', value: 1000 } } });

  // Customers
  const customers = [
    { name: 'Priya Shah', phone: '9876500001', gender: 'female', dob: '1994-03-12', tags: ['vip'] },
    { name: 'Ananya Iyer', phone: '9876500002', gender: 'female' },
    { name: 'Rohan Gupta', phone: '9876500003', gender: 'male', source: 'phone' },
    { name: 'Meera Nair', phone: '9876500004', gender: 'female', source: 'whatsapp' },
    { name: 'Vikram Singh', phone: '9876500005', gender: 'male' },
    { name: 'Sneha Kapoor', phone: '9876500006', gender: 'female', source: 'referral' },
  ];
  for (const c of customers) {
    if (await Customer.exists({ businessId, phone: `+91${c.phone}` })) {
      log('exists ', `customer ${c.name}`);
      continue;
    }
    await customerService.createCustomer(ownerCtx, { source: 'walk_in', tags: [], waOptIn: true, doNotMessage: false, ...c });
    log('created', `customer ${c.name}`);
  }

  // ---- Phase 2/3: vendors, plans, appointments, bills, an expense and a pending PO ----
  const vendor = async (name: string, phone: string) => {
    const found = await Vendor.findOne({ businessId, name });
    if (found) return (log('exists ', `vendor ${name}`), found);
    log('created', `vendor ${name}`);
    return catalogueService.createVendor(ownerCtx, { name, phone, contact: 'Sales desk' });
  };
  const distributor = await vendor('Glam Beauty Distributors', '+919822200010');
  await vendor('Surat Salon Supplies', '+919822200011');

  const plan = async (data: any) => {
    const found = await Plan.findOne({ businessId, name: data.name });
    if (found) return (log('exists ', `plan ${data.name}`), found);
    log('created', `plan ${data.name}`);
    return createPlan(ownerCtx, { branchScope: [], active: true, ...data });
  };
  const haircutMen = await Service.findOne({ businessId, name: 'Haircut (Men)' });
  const gold = await plan({ type: 'membership', name: 'Gold Membership', pricePaise: 200000, validityDays: 365, membership: { serviceDiscountBps: 2000, productDiscountBps: 0 } });
  const pack = await plan({ type: 'package', name: '6 Men\'s Haircuts', pricePaise: 150000, validityDays: 180, package: { items: [{ serviceId: haircutMen!._id.toString(), sessions: 6 }] } });
  await plan({ type: 'wallet_offer', name: 'Pay ₹5,000 get ₹6,000', pricePaise: 500000, validityDays: 365, walletOffer: { creditPaise: 600000 } });
  await plan({ type: 'voucher', name: '₹1,000 Gift Voucher', pricePaise: 100000, validityDays: 90, voucher: { valuePaise: 100000 } });

  const priya = await Customer.findOne({ businessId, phone: '+919876500001' });
  const ananya = await Customer.findOne({ businessId, phone: '+919876500002' });
  const rohan = await Customer.findOne({ businessId, phone: '+919876500003' });
  const sameer = await Staff.findOne({ businessId, name: 'Sameer Khan' });
  const tara = await Staff.findOne({ businessId, name: 'Tara Patel' });
  const riya = await Staff.findOne({ businessId, name: 'Riya Mehta' });
  const haircutWomenSvc = await Service.findOne({ businessId, name: 'Haircut (Women)' });
  const spa = await Service.findOne({ businessId, name: 'Hair Spa' });
  const shampoo = await Product.findOne({ businessId, name: 'Argan Shampoo' });

  // Appointments tomorrow in TST1
  const tomorrow = addDays(getBusinessDate(), 1);
  const book = async (customer: any, svc: any, staff: any, time: string) => {
    if (await Appointment.exists({ businessId, customerId: customer._id, businessDate: tomorrow })) {
      return log('exists ', `appointment ${customer.name} ${tomorrow}`);
    }
    try {
      await appointmentService.createAppointment(ownerCtx, branch1._id.toString(), {
        customerId: customer._id.toString(),
        lines: [{ serviceId: svc._id.toString(), staffId: staff._id.toString(), start: parseIstDateTime(tomorrow, time).toISOString() }],
        source: 'phone',
      });
      log('created', `appointment ${customer.name} ${tomorrow} ${time}`);
    } catch (err: any) {
      console.log(`skipped  appointment ${customer.name}: ${err.message}`);
    }
  };
  await book(ananya, haircutWomenSvc, tara, '11:00');
  await book(rohan, haircutMen, sameer, '12:00');

  // Bills today in TST1 (fixed idempotency keys: re-running returns the same bills)
  const bill = async (key: string, label: string, draft: any) => {
    try {
      const b = await billingService.createBill(ownerCtx, branch1._id.toString(), { billedByStaffId: riya!._id.toString(), ...draft }, `seed-${key}`);
      console.log(`bill     ${label}: ${b.invoiceNo} ${b.status} ₹${(b.totals.totalPaise / 100).toFixed(2)}`);
    } catch (err: any) {
      console.log(`skipped  bill ${label}: ${err.message}`);
    }
  };
  const cash = (paise: number) => [{ mode: 'cash', amountPaise: paise }];
  await bill('1', 'Priya haircut + Gold membership', {
    customerId: priya!._id.toString(),
    lines: [
      { kind: 'service', refId: haircutWomenSvc!._id.toString(), qty: 1, staff: [{ staffId: tara!._id.toString(), splitBps: 10000 }] },
      { kind: 'membership', refId: gold._id.toString(), qty: 1 },
    ],
    payments: [{ mode: 'upi', amountPaise: 260000, ref: 'UPI-SEED-1' }],
  });
  await bill('2', 'Rohan package', { customerId: rohan!._id.toString(), lines: [{ kind: 'package', refId: pack._id.toString(), qty: 1 }], payments: cash(150000) });
  await bill('3', 'Ananya spa + shampoo, part paid', {
    customerId: ananya!._id.toString(),
    lines: [
      { kind: 'service', refId: spa!._id.toString(), qty: 1, staff: [{ staffId: sameer!._id.toString(), splitBps: 10000 }] },
      { kind: 'product', refId: shampoo!._id.toString(), qty: 1, staff: [{ staffId: sameer!._id.toString(), splitBps: 10000 }] },
    ],
    payments: cash(100000),
  });

  // An expense today and a pending purchase order
  if (!(await Expense.exists({ businessId, branchId: branch1._id, note: 'Seed: tea and snacks' }))) {
    await createExpense(ownerCtx, branch1._id, { category: 'tea_snacks', amountPaise: 25000, mode: 'cash', paidFrom: 'till', note: 'Seed: tea and snacks' });
    log('created', 'expense tea and snacks ₹250 (till)');
  }
  if (!(await PurchaseOrder.exists({ businessId, vendorId: distributor._id }))) {
    await createPurchaseOrder(ownerCtx, {
      branchId: branch1._id.toString(),
      vendorId: distributor._id.toString(),
      items: [
        { productId: colourTube._id.toString(), qtyPurchaseUnits: 10, ratePaise: 50000 },
        { productId: shampoo!._id.toString(), qtyPurchaseUnits: 12, ratePaise: 30000 },
      ],
    });
    log('created', 'purchase order (pending approval)');
  }

  // ---- Phase 4: a draft payroll run for this month (draft only: it never freezes bills) ----
  const month = getBusinessDate().slice(0, 7);
  const run = await PayrollRun.findOne({ businessId, branchId: branch1._id, month });
  if (!run) {
    await createMonthlyRun(ownerCtx, branch1._id, { month });
    log('created', `payroll draft TST1 ${month}`);
  } else if (run.status === 'draft' || run.status === 'reviewed') {
    await createMonthlyRun(ownerCtx, branch1._id, { month });
    log('exists ', `payroll draft TST1 ${month} (recalculated)`);
  }

  console.log('\nDone. Logins: owner@glox.test, manager@glox.test, branch@glox.test (TST1), branch2@glox.test (TST2) — Test@1234');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDb();
    process.exit();
  });
