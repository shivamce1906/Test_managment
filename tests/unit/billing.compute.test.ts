import { computeBill, ComputeBillInput, ComputeLineItem } from '../../src/services/billing.compute';

const svc = (price: number, extra: Partial<ComputeLineItem> = {}): ComputeLineItem => ({
  _id: `svc${Math.random()}`,
  kind: 'service',
  refId: 'svc',
  name: 'Haircut',
  qty: 1,
  unitPricePaise: price,
  ...extra,
});
const prod = (price: number, extra: Partial<ComputeLineItem> = {}): ComputeLineItem => ({
  _id: `prod${Math.random()}`,
  kind: 'product',
  refId: 'prod',
  name: 'Shampoo',
  qty: 1,
  unitPricePaise: price,
  ...extra,
});
const staffPct = (bps: number, splitBps = 10000, id = 's1') => ({
  staffId: id,
  name: id,
  splitBps,
  rule: { type: 'pct' as const, value: bps },
});

const run = (input: Partial<ComputeBillInput>) =>
  computeBill({ lines: [], gstApplied: true, businessGstBps: 1800, ...input } as ComputeBillInput);

describe('computeBill — GST (PRD §7, BR-01/02)', () => {
  it('₹1,000 service with GST on -> ₹1,180 (CGST 90 + SGST 90)', () => {
    const r = run({ lines: [svc(100000)] });
    expect(r.totals).toMatchObject({
      grossPaise: 100000,
      taxablePaise: 100000,
      cgstPaise: 9000,
      sgstPaise: 9000,
      totalPaise: 118000,
      roundOffPaise: 0,
    });
  });

  it('GST off -> plain bill, no tax lines', () => {
    const r = run({ lines: [svc(100000)], gstApplied: false });
    expect(r.totals.cgstPaise + r.totals.sgstPaise).toBe(0);
    expect(r.totals.totalPaise).toBe(100000);
    expect(r.lines[0].gstBps).toBe(0);
  });

  it('product uses its own GST rate (12%)', () => {
    const r = run({ lines: [prod(100000, { gstBps: 1200 })] });
    expect(r.totals.cgstPaise + r.totals.sgstPaise).toBe(12000);
  });

  it('product with 0% GST is not taxed at the service rate', () => {
    const r = run({ lines: [prod(100000, { gstBps: 0 })] });
    expect(r.totals.cgstPaise + r.totals.sgstPaise).toBe(0);
  });

  it('wallet top-up and gift voucher lines carry no GST', () => {
    const r = run({
      lines: [
        { _id: 'w', kind: 'wallet_topup', refId: 'p', name: 'Wallet', qty: 1, unitPricePaise: 1000000 },
        { _id: 'v', kind: 'voucher', refId: 'p', name: 'Voucher', qty: 1, unitPricePaise: 200000 },
      ],
    });
    expect(r.totals.cgstPaise + r.totals.sgstPaise).toBe(0);
    expect(r.totals.totalPaise).toBe(1200000);
  });

  it('membership/package sale lines DO carry GST (PRD §8 "Sale is a bill line, so it carries GST")', () => {
    const r = run({
      lines: [{ _id: 'm', kind: 'membership', refId: 'p', name: 'Gold', qty: 1, unitPricePaise: 200000 }],
    });
    expect(r.totals.cgstPaise + r.totals.sgstPaise).toBe(36000);
  });

  it('sum of line totals equals bill total before round-off', () => {
    const r = run({ lines: [svc(33333), svc(44444), prod(12345, { gstBps: 1200 })] });
    const lineSum = r.lines.reduce((a, l) => a + l.totalPaise, 0);
    expect(lineSum + r.totals.roundOffPaise).toBe(r.totals.totalPaise);
  });
});

describe('computeBill — discounts in PRD order (line -> bill -> redemptions -> GST)', () => {
  it('10% line discount', () => {
    const r = run({ lines: [svc(100000, { lineDiscount: { type: 'pct', value: 1000 } })] });
    expect(r.totals.taxablePaise).toBe(90000);
    expect(r.totals.totalPaise).toBe(106200);
    expect(r.totals.discountPaise).toBe(10000);
  });

  it('amount line discount larger than the line is capped at the line value', () => {
    const r = run({ lines: [svc(100000, { lineDiscount: { type: 'amount', value: 500000 } })] });
    expect(r.totals.taxablePaise).toBe(0);
    expect(r.totals.totalPaise).toBe(0);
  });

  it('line discount applies before bill discount (compounding)', () => {
    const r = run({
      lines: [svc(100000, { lineDiscount: { type: 'pct', value: 1000 } })],
      billDiscount: { type: 'pct', value: 1000 },
    });
    expect(r.totals.taxablePaise).toBe(81000);
  });

  it('bill discount is spread pro-rata and sums exactly', () => {
    const r = run({ lines: [svc(100000), svc(50000)], billDiscount: { type: 'amount', value: 10001 } });
    expect(r.totals.discountPaise).toBe(10001);
    expect(r.totals.taxablePaise).toBe(139999);
  });

  it('bill discount amount above bill value is capped', () => {
    const r = run({ lines: [svc(100000)], billDiscount: { type: 'amount', value: 9999999 } });
    expect(r.totals.taxablePaise).toBe(0);
  });

  it('100% discount -> zero bill, zero commission, no NaN', () => {
    const r = run({
      lines: [svc(100000, { staff: [staffPct(1000)], lineDiscount: { type: 'pct', value: 10000 } })],
    });
    expect(r.totals.totalPaise).toBe(0);
    expect(r.lines[0].staff![0].commissionPaise).toBe(0);
  });

  it('zero-priced service does not produce NaN', () => {
    const r = run({ lines: [svc(0)], billDiscount: { type: 'pct', value: 1000 } });
    expect(r.totals.totalPaise).toBe(0);
    expect(Number.isNaN(r.totals.taxablePaise)).toBe(false);
  });

  it('qty > 1 multiplies price before discounts', () => {
    const r = run({ lines: [svc(50000, { qty: 3, lineDiscount: { type: 'pct', value: 1000 } })] });
    expect(r.totals.grossPaise).toBe(150000);
    expect(r.totals.taxablePaise).toBe(135000);
  });

  it('loyalty redemption reduces taxable value before GST', () => {
    const r = run({
      lines: [svc(100000)],
      redemptions: [{ kind: 'loyalty', refId: 'c', points: 100, amountPaise: 10000 }],
    });
    expect(r.totals.taxablePaise).toBe(90000);
    expect(r.totals.cgstPaise).toBe(8100);
  });

  it('EDGE: bill discount is not lost/over-applied when a package-redeemed line is last', () => {
    const lines = [svc(100), svc(100), svc(5000, { _id: 'pkg' })];
    const r = run({
      lines,
      gstApplied: false,
      billDiscount: { type: 'amount', value: 3 },
      redemptions: [{ kind: 'package', refId: 'cp', lineId: 'pkg', perSessionValuePaise: 5000 }],
    });
    // Exactly ₹0.03 of discount must land on the two paid lines: 200 - 3 = 197
    expect(r.lines[0].taxablePaise + r.lines[1].taxablePaise).toBe(197);
  });
});

describe('computeBill — membership discount (PRD §8)', () => {
  it('applies membership % to service lines', () => {
    const r = run({
      lines: [svc(100000)],
      gstApplied: false,
      redemptions: [{ kind: 'membership', refId: 'cp', membershipDiscountBps: 2000 }],
    });
    expect(r.totals.taxablePaise).toBe(80000);
  });

  it('service-only membership must NOT discount retail products', () => {
    // Plan: 20% off services, 0% off products. Only one bps reaches compute.
    const r = run({
      lines: [svc(100000), prod(50000, { gstBps: 1800 })],
      gstApplied: false,
      redemptions: [{ kind: 'membership', refId: 'cp', membershipDiscountBps: 2000 }],
    });
    const productLine = r.lines.find((l) => l.kind === 'product')!;
    expect(productLine.taxablePaise).toBe(50000);
  });

  it('membership must NOT discount a wallet top-up purchase', () => {
    const r = run({
      lines: [svc(100000), { _id: 'w', kind: 'wallet_topup', refId: 'p', name: 'Wallet', qty: 1, unitPricePaise: 1000000 }],
      gstApplied: false,
      redemptions: [{ kind: 'membership', refId: 'cp', membershipDiscountBps: 2000 }],
    });
    const wallet = r.lines.find((l) => l.kind === 'wallet_topup')!;
    expect(wallet.taxablePaise).toBe(1000000);
  });
});

describe('computeBill — package redemption', () => {
  it('redeemed line is zero-valued and untaxed', () => {
    const r = run({
      lines: [svc(150000, { _id: 'L1' })],
      redemptions: [{ kind: 'package', refId: 'cp', lineId: 'L1', perSessionValuePaise: 150000 }],
    });
    expect(r.totals.totalPaise).toBe(0);
  });

  it('commission on a redeemed session uses per-session value', () => {
    const r = run({
      lines: [svc(150000, { _id: 'L1', staff: [staffPct(1000)] })],
      redemptions: [{ kind: 'package', refId: 'cp', lineId: 'L1', perSessionValuePaise: 120000 }],
    });
    expect(r.lines[0].staff![0].commissionPaise).toBe(12000);
  });
});

describe('computeBill — commission (PRD §9: post-discount, pre-GST)', () => {
  it('PRD example: ₹1,000 service + ₹180 GST at 10% = ₹100 commission', () => {
    const r = run({ lines: [svc(100000, { staff: [staffPct(1000)] })] });
    expect(r.lines[0].staff![0].commissionPaise).toBe(10000);
  });

  it('commission is on the discounted value', () => {
    const r = run({
      lines: [svc(100000, { staff: [staffPct(1000)], lineDiscount: { type: 'pct', value: 2000 } })],
    });
    expect(r.lines[0].staff![0].commissionPaise).toBe(8000);
  });

  it('commission is the same whether GST is on or off', () => {
    const on = run({ lines: [svc(100000, { staff: [staffPct(1000)] })], gstApplied: true });
    const off = run({ lines: [svc(100000, { staff: [staffPct(1000)] })], gstApplied: false });
    expect(on.lines[0].staff![0].commissionPaise).toBe(off.lines[0].staff![0].commissionPaise);
  });

  it('50/50 split between two staff', () => {
    const r = run({ lines: [svc(100000, { staff: [staffPct(1000, 5000, 'a'), staffPct(1000, 5000, 'b')] })] });
    expect(r.lines[0].staff!.map((s) => s.commissionPaise)).toEqual([5000, 5000]);
  });

  it('EDGE: 3-way split never pays out more than the line commission', () => {
    // taxable 10010 @10% = 1001 paise commission, split 33.33/33.33/33.34
    const r = run({
      lines: [svc(10010, { staff: [staffPct(1000, 3333, 'a'), staffPct(1000, 3333, 'b'), staffPct(1000, 3334, 'c')] })],
      gstApplied: false,
    });
    const paid = r.lines[0].staff!.reduce((a, s) => a + (s.commissionPaise || 0), 0);
    expect(paid).toBe(1001);
  });

  it('fixed commission per service multiplies by qty', () => {
    const r = run({
      lines: [svc(100000, { qty: 2, staff: [{ staffId: 's', name: 's', splitBps: 10000, rule: { type: 'fixed', value: 5000 } }] })],
    });
    expect(r.lines[0].staff![0].commissionPaise).toBe(10000);
  });

  it('slab commission rule (PRD: "10% up to ₹50,000; 15% above") produces a commission', () => {
    const r = run({
      lines: [svc(100000, {
        staff: [{
          staffId: 's', name: 's', splitBps: 10000,
          rule: { type: 'slab', slabs: [{ uptoPaise: 5000000, bps: 1000 }, { uptoPaise: 999999999, bps: 1500 }] },
        }],
      })],
    });
    expect(r.lines[0].staff![0].commissionPaise).toBeGreaterThan(0);
  });

  it('product sales commission uses productBps on the post-discount value', () => {
    const r = run({ lines: [prod(50000, { gstBps: 1800, staff: [{ staffId: 's', name: 's', splitBps: 10000, productBps: 500 }] })] });
    expect(r.lines[0].staff![0].commissionPaise).toBe(2500);
  });
});

describe('computeBill — tips, payments, dues, round-off', () => {
  it('tips are added to payable but carry no GST and are not sales', () => {
    const r = run({
      lines: [svc(100000)],
      tips: [{ staffId: 's', staffName: 's', amountPaise: 10000, payout: 'cash_today' }],
      payments: [{ mode: 'cash', amountPaise: 128000 }],
    });
    expect(r.totals.taxablePaise).toBe(100000);
    expect(r.totals.totalPaise).toBe(118000);
    expect(r.totals.totalTipsPaise).toBe(10000);
    expect(r.totals.duePaise).toBe(0);
  });

  it('split payment cash + UPI + card settles the bill', () => {
    const r = run({
      lines: [svc(100000)],
      payments: [
        { mode: 'cash', amountPaise: 18000 },
        { mode: 'upi', amountPaise: 50000 },
        { mode: 'card', amountPaise: 50000 },
      ],
    });
    expect(r.totals.paidPaise).toBe(118000);
    expect(r.totals.duePaise).toBe(0);
  });

  it('partial payment leaves a due', () => {
    const r = run({ lines: [svc(100000)], payments: [{ mode: 'cash', amountPaise: 100000 }] });
    expect(r.totals.duePaise).toBe(18000);
  });

  it('no payment -> full due', () => {
    const r = run({ lines: [svc(100000)] });
    expect(r.totals.duePaise).toBe(118000);
  });

  it('round-off to nearest rupee', () => {
    const r = run({ lines: [svc(99999)], gstApplied: false, payments: [] });
    expect(r.totals.roundOffPaise).toBe(1);
    expect(r.totals.totalPaise).toBe(100000);
  });

  it('round-off with GST (₹845.00 + 18% = ₹997.10 -> ₹997)', () => {
    const r = run({ lines: [svc(84500)] });
    expect(r.totals.cgstPaise + r.totals.sgstPaise).toBe(15210);
    expect(r.totals.totalPaise).toBe(99700);
    expect(r.totals.roundOffPaise).toBe(-10);
  });

  it('large bill (10 × ₹10 lakh) stays exact and integer', () => {
    const r = run({ lines: Array.from({ length: 10 }, () => svc(100_000_000)) });
    expect(r.totals.totalPaise).toBe(1_180_000_000);
    expect(Number.isSafeInteger(r.totals.totalPaise)).toBe(true);
  });

  it('all money outputs are integers for awkward prices', () => {
    const r = run({
      lines: [svc(33333, { lineDiscount: { type: 'pct', value: 333 } }), prod(7777, { gstBps: 500 }), svc(1)],
      billDiscount: { type: 'pct', value: 777 },
    });
    for (const v of Object.values(r.totals)) expect(Number.isInteger(v)).toBe(true);
    for (const l of r.lines) {
      [l.taxablePaise, l.cgstPaise, l.sgstPaise, l.totalPaise, l.discountPaise].forEach((v) => expect(Number.isInteger(v)).toBe(true));
    }
  });
});
