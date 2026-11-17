import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, createPlan } from '../helpers/factory';
import { Bill, CustomerPlan } from '../../src/models';

describe('Real-World Integration Test: Discount Control on Memberships', () => {
  useTestDb();
  let w: World;

  beforeEach(async () => {
    w = await seedWorld();
  });

  it('checkout bill discount excludes membership line when combined with service and product', async () => {
    // 1. Create a Membership Plan: Gold Membership ₹2,000 (200000 paise)
    const membershipPlan = await createPlan(w.business._id, {
      type: 'membership',
      name: 'Gold Membership',
      pricePaise: 200000,
      validityDays: 365,
      membership: { serviceDiscountBps: 1000, productDiscountBps: 500 },
    });

    // Haircut Service: 100000 paise (₹1,000)
    // Retail Product: 50000 paise (₹500)
    // Gold Membership: 200000 paise (₹2,000)
    // Gross: 350000 paise (₹3,500)
    // 10% checkout bill discount (1000 bps):
    // Eligible items = Service (100000) + Product (50000) = 150000 paise
    // Discount = 10% of 150000 = 15000 paise (₹150 total discount)
    // - Service gets: 10000 paise discount -> taxable: 90000 paise, 18% GST = 16200 paise -> line total = 106200
    // - Product gets: 5000 paise discount -> taxable: 45000 paise, 18% GST = 8100 paise -> line total = 53100
    // - Membership gets: 0 paise discount -> taxable: 200000 paise, 18% GST = 36000 paise -> line total = 236000
    // Total payable = 106200 + 53100 + 236000 = 395300 paise (₹3,953.00)

    const billPayload = {
      customerId: w.customer._id.toString(),
      billedByStaffId: w.receptionist._id.toString(),
      lines: [
        {
          kind: 'service',
          refId: w.haircut._id.toString(),
          qty: 1,
          staff: [{ staffId: w.stylist1._id.toString(), splitBps: 10000 }],
        },
        {
          kind: 'product',
          refId: w.retail._id.toString(),
          qty: 1,
          staff: [{ staffId: w.stylist1._id.toString(), splitBps: 10000 }],
        },
        {
          kind: 'membership',
          refId: membershipPlan._id.toString(),
          qty: 1,
        },
      ],
      billDiscount: { type: 'pct', value: 1000 }, // 10% checkout discount
      payments: [{ mode: 'cash', amountPaise: 395300 }],
    };

    const res = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, billPayload);
    expect(res.status).toBe(201);

    const savedBill = await Bill.findOne({ _id: res.body._id, businessId: w.business._id });
    expect(savedBill).toBeTruthy();
    expect(savedBill!.status).toBe('paid');

    // Total discount should be exactly 15000 paise (₹150), NOT 35000 paise (₹350)
    expect(savedBill!.totals.discountPaise).toBe(15000);
    expect(savedBill!.totals.grossPaise).toBe(350000);
    expect(savedBill!.totals.taxablePaise).toBe(335000); // 90000 + 45000 + 200000
    expect(savedBill!.totals.totalPaise).toBe(395300);

    // Verify individual line item details
    const serviceLine = savedBill!.lines.find((l) => l.kind === 'service')!;
    const productLine = savedBill!.lines.find((l) => l.kind === 'product')!;
    const membershipLine = savedBill!.lines.find((l) => l.kind === 'membership')!;

    expect(serviceLine.discountPaise).toBe(10000); // ₹100 discount
    expect(serviceLine.taxablePaise).toBe(90000); // ₹900 taxable
    expect(serviceLine.totalPaise).toBe(106200); // ₹1,062 with GST

    expect(productLine.discountPaise).toBe(5000); // ₹50 discount
    expect(productLine.taxablePaise).toBe(45000); // ₹450 taxable
    expect(productLine.totalPaise).toBe(53100); // ₹531 with GST

    // MEMBERSHIP MUST HAVE ZERO DISCOUNT AND FULL PRICE
    expect(membershipLine.discountPaise).toBe(0); // ₹0 discount
    expect(membershipLine.taxablePaise).toBe(200000); // Full ₹2,000 price
    expect(membershipLine.totalPaise).toBe(236000); // ₹2,360 with GST

    // Ensure customer plan was successfully activated for the customer
    const activeCustomerPlan = await CustomerPlan.findOne({
      businessId: w.business._id,
      customerId: w.customer._id,
      status: 'active',
    });
    expect(activeCustomerPlan).toBeTruthy();
    expect(activeCustomerPlan!.planSnap.name).toBe('Gold Membership');
  });

  it('checkout bill discount does not discount a solo membership purchase', async () => {
    const membershipPlan = await createPlan(w.business._id, {
      type: 'membership',
      name: 'Silver Membership',
      pricePaise: 100000,
      validityDays: 180,
    });

    const billPayload = {
      customerId: w.customer._id.toString(),
      billedByStaffId: w.receptionist._id.toString(),
      lines: [
        {
          kind: 'membership',
          refId: membershipPlan._id.toString(),
          qty: 1,
        },
      ],
      billDiscount: { type: 'pct', value: 1000 }, // 10% checkout discount
      payments: [{ mode: 'cash', amountPaise: 118000 }], // Full price ₹1,000 + 18% GST = ₹1,180
    };

    const res = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, billPayload);
    expect(res.status).toBe(201);
    expect(res.body.totals.discountPaise).toBe(0);
    expect(res.body.totals.totalPaise).toBe(118000);
  });
});
