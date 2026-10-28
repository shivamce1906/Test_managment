import {
  calculateBps,
  splitGst,
  distributeProRata,
  calculateRoundOff,
} from '../utils';

export interface ComputeLineItem {
  _id?: any;
  kind: 'service' | 'product' | 'membership' | 'package' | 'wallet_topup' | 'voucher';
  refId: any;
  name: string;
  hsnSac?: string;
  qty: number;
  unitPricePaise: number;
  lineDiscount?: {
    type: 'amount' | 'pct';
    value: number; // paise if amount, bps if pct
  };
  staff?: {
    staffId: any;
    name: string;
    splitBps: number;
    commissionPaise?: number;
    rule?: {
      type: 'pct' | 'fixed' | 'slab';
      value?: number;
      slabs?: { uptoPaise: number; bps: number }[];
    };
    productBps?: number;
  }[];
  consumablesUsed?: {
    productId: any;
    qty: number;
    costPaise: number;
  }[];
  gstBps?: number;
}

export interface ComputeBillInput {
  lines: ComputeLineItem[];
  billDiscount?: {
    type: 'amount' | 'pct';
    value: number;
  };
  redemptions?: {
    kind: 'package' | 'membership' | 'loyalty' | 'voucher';
    refId: any;
    lineId?: any;
    points?: number;
    amountPaise?: number;
    membershipDiscountBps?: number;
    perSessionValuePaise?: number;
  }[];
  tips?: {
    staffId: any;
    staffName: string;
    amountPaise: number;
    payout: 'cash_today' | 'payroll';
  }[];
  payments?: {
    mode: 'cash' | 'upi' | 'card' | 'wallet';
    amountPaise: number;
    tenderedPaise?: number;
    ref?: string;
    businessDate?: string;
  }[];
  gstApplied: boolean;
  businessGstBps: number;
}

export interface ComputeBillOutput {
  lines: (ComputeLineItem & {
    discountPaise: number;
    taxablePaise: number;
    gstBps: number;
    cgstPaise: number;
    sgstPaise: number;
    totalPaise: number;
  })[];
  totals: {
    grossPaise: number;
    discountPaise: number;
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    roundOffPaise: number;
    totalPaise: number;
    paidPaise: number;
    duePaise: number;
    totalTipsPaise: number;
  };
}

export function computeBill(input: ComputeBillInput): ComputeBillOutput {
  const { lines, billDiscount, redemptions = [], tips = [], payments = [], gstApplied, businessGstBps } = input;

  let totalGrossPaise = 0;
  const lineDrafts = lines.map((line, idx) => {
    const grossPaise = line.unitPricePaise * line.qty;
    totalGrossPaise += grossPaise;

    // 1. Line discount
    let lineDiscountPaise = 0;
    if (line.lineDiscount) {
      if (line.lineDiscount.type === 'amount') {
        lineDiscountPaise = Math.min(grossPaise, line.lineDiscount.value);
      } else if (line.lineDiscount.type === 'pct') {
        lineDiscountPaise = Math.min(grossPaise, calculateBps(grossPaise, line.lineDiscount.value));
      }
    }

    // 2. Membership discount (if applicable)
    let membershipDiscountPaise = 0;
    const membershipRedemption = redemptions.find((r) => r.kind === 'membership');
    if (membershipRedemption && membershipRedemption.membershipDiscountBps) {
      const remainingVal = grossPaise - lineDiscountPaise;
      membershipDiscountPaise = calculateBps(remainingVal, membershipRedemption.membershipDiscountBps);
    }

    // Check package redemption for this line
    const isPackageRedeemed = redemptions.some(
      (r) => r.kind === 'package' && (r.lineId?.toString() === line._id?.toString() || r.lineId === idx.toString())
    );

    return {
      ...line,
      grossPaise,
      lineDiscountPaise,
      membershipDiscountPaise,
      isPackageRedeemed,
      preBillDiscountValue: isPackageRedeemed ? 0 : Math.max(0, grossPaise - lineDiscountPaise - membershipDiscountPaise),
    };
  });

  // 3. Bill discount pro-rata spread
  let totalBillDiscountPaise = 0;
  const sumPreBillVal = lineDrafts.reduce((acc, l) => acc + l.preBillDiscountValue, 0);

  if (billDiscount && sumPreBillVal > 0) {
    if (billDiscount.type === 'amount') {
      totalBillDiscountPaise = Math.min(sumPreBillVal, billDiscount.value);
    } else if (billDiscount.type === 'pct') {
      totalBillDiscountPaise = Math.min(sumPreBillVal, calculateBps(sumPreBillVal, billDiscount.value));
    }
  }

  const billDiscountShares = distributeProRata(
    totalBillDiscountPaise,
    lineDrafts.map((l) => l.preBillDiscountValue)
  );

  // 4. Loyalty & Voucher redemption discounts
  const redemptionDiscountPaise = redemptions
    .filter((r) => r.kind === 'loyalty' || r.kind === 'voucher')
    .reduce((sum, r) => sum + (r.amountPaise || 0), 0);

  const redemptionShares = distributeProRata(
    redemptionDiscountPaise,
    lineDrafts.map((l, i) => Math.max(0, l.preBillDiscountValue - billDiscountShares[i]))
  );

  // 5. Final line values, GST, and Commission
  let totalTaxablePaise = 0;
  let totalCgstPaise = 0;
  let totalSgstPaise = 0;
  let totalAllDiscountsPaise = 0;

  const computedLines = lineDrafts.map((l, i) => {
    let taxablePaise = l.isPackageRedeemed
      ? 0
      : Math.max(0, l.preBillDiscountValue - billDiscountShares[i] - redemptionShares[i]);

    const lineTotalDiscount = l.grossPaise - taxablePaise;
    totalAllDiscountsPaise += lineTotalDiscount;
    totalTaxablePaise += taxablePaise;

    // GST calculation (BR-02)
    // Tips, wallet top-ups, and dues carry no GST
    const isExemptFromGst = l.kind === 'wallet_topup' || l.kind === 'voucher';
    let gstBps = 0;
    let cgstPaise = 0;
    let sgstPaise = 0;

    if (gstApplied && !isExemptFromGst && taxablePaise > 0) {
      if (l.kind === 'service') {
        gstBps = businessGstBps || 1800;
      } else if (l.kind === 'product') {
        gstBps = l.gstBps !== undefined ? l.gstBps : businessGstBps || 1800;
      } else {
        gstBps = businessGstBps || 1800;
      }

      const gst = splitGst(taxablePaise, gstBps);
      cgstPaise = gst.cgstPaise;
      sgstPaise = gst.sgstPaise;
      totalCgstPaise += cgstPaise;
      totalSgstPaise += sgstPaise;
    }

    const lineTotalPaise = taxablePaise + cgstPaise + sgstPaise;

    // Commission calculation (BR-03): on taxablePaise before GST
    const computedStaff = (l.staff || []).map((st) => {
      let baseCommissionValue = taxablePaise;

      // Package redemption commission basis is perSessionValuePaise
      if (l.isPackageRedeemed) {
        const pkgRedeem = redemptions.find(
          (r) => r.kind === 'package' && (r.lineId?.toString() === l._id?.toString() || r.lineId === i.toString())
        );
        if (pkgRedeem && pkgRedeem.perSessionValuePaise) {
          baseCommissionValue = pkgRedeem.perSessionValuePaise;
        }
      }

      let lineCommissionPaise = 0;
      if (l.kind === 'service' && st.rule) {
        if (st.rule.type === 'pct' && st.rule.value) {
          lineCommissionPaise = calculateBps(baseCommissionValue, st.rule.value);
        } else if (st.rule.type === 'fixed' && st.rule.value) {
          lineCommissionPaise = st.rule.value * l.qty;
        }
      } else if (l.kind === 'product' && st.productBps) {
        lineCommissionPaise = calculateBps(baseCommissionValue, st.productBps);
      }

      // Split commission by splitBps (out of 10000 bps)
      const commissionPaise = calculateBps(lineCommissionPaise, st.splitBps || 10000);

      return {
        staffId: st.staffId,
        name: st.name,
        splitBps: st.splitBps || 10000,
        commissionPaise,
      };
    });

    return {
      _id: l._id,
      kind: l.kind,
      refId: l.refId,
      name: l.name,
      hsnSac: l.hsnSac,
      qty: l.qty,
      unitPricePaise: l.unitPricePaise,
      lineDiscount: l.lineDiscount,
      discountPaise: lineTotalDiscount,
      taxablePaise,
      gstBps,
      cgstPaise,
      sgstPaise,
      totalPaise: lineTotalPaise,
      staff: computedStaff,
      consumablesUsed: l.consumablesUsed,
    };
  });

  // Calculate unrounded total
  const unroundedTotalPaise = totalTaxablePaise + totalCgstPaise + totalSgstPaise;
  const { roundOffPaise, roundedTotalPaise } = calculateRoundOff(unroundedTotalPaise);

  const totalTipsPaise = tips.reduce((sum, t) => sum + t.amountPaise, 0);
  const totalPaidPaise = payments.reduce((sum, p) => sum + p.amountPaise, 0);

  // Total payable by customer = roundedTotalPaise + tips
  const totalPayablePaise = roundedTotalPaise + totalTipsPaise;
  const duePaise = Math.max(0, totalPayablePaise - totalPaidPaise);

  return {
    lines: computedLines,
    totals: {
      grossPaise: totalGrossPaise,
      discountPaise: totalAllDiscountsPaise,
      taxablePaise: totalTaxablePaise,
      cgstPaise: totalCgstPaise,
      sgstPaise: totalSgstPaise,
      roundOffPaise,
      totalPaise: roundedTotalPaise,
      paidPaise: totalPaidPaise,
      duePaise,
      totalTipsPaise,
    },
  };
}
