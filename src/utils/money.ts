/**
 * Money calculations in integer paise.
 * ₹1 = 100 paise.
 * Percentages are expressed in basis points (1% = 100 bps).
 */

export function paiseToRupees(paise: number): number {
  return paise / 100;
}

export function rupeesToPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) return 0;
  return Math.round(Number((rupees * 100).toFixed(8)));
}

/**
 * Calculates basis points of an amount in paise.
 * bps: 100 = 1%, 1800 = 18%.
 * Uses integer math with rounding to the nearest paisa.
 */
export function calculateBps(amountPaise: number, bps: number): number {
  if (amountPaise === 0 || bps === 0) return 0;
  return Math.round((amountPaise * bps) / 10000);
}

/**
 * Splits GST equally into CGST and SGST.
 * Both are rounded to the nearest paisa.
 */
export function splitGst(taxablePaise: number, gstBps: number): { cgstPaise: number; sgstPaise: number; totalGstPaise: number } {
  if (taxablePaise <= 0 || gstBps <= 0) {
    return { cgstPaise: 0, sgstPaise: 0, totalGstPaise: 0 };
  }
  const halfBps = gstBps / 2;
  const cgstPaise = Math.round((taxablePaise * halfBps) / 10000);
  const sgstPaise = Math.round((taxablePaise * halfBps) / 10000);
  return { cgstPaise, sgstPaise, totalGstPaise: cgstPaise + sgstPaise };
}

/**
 * Pro-rata distribution of an integer discount or value across parts according to their weights.
 * Uses largest-remainder method (Hare-Niemeyer) so zero-weight items get 0,
 * no shares are negative, and shares always sum to total.
 */
export function distributeProRata(totalAmount: number, weights: number[]): number[] {
  const sumWeights = weights.reduce((acc, w) => acc + Math.max(0, w), 0);
  if (sumWeights === 0 || totalAmount === 0) {
    return weights.map(() => 0);
  }

  const items = weights.map((w, index) => {
    if (w <= 0) {
      return { index, weight: 0, floor: 0, remainder: 0 };
    }
    const exact = (totalAmount * w) / sumWeights;
    const floor = Math.floor(exact);
    const remainder = exact - floor;
    return { index, weight: w, floor, remainder };
  });

  const allocated = items.reduce((acc, it) => acc + it.floor, 0);
  const deficit = totalAmount - allocated;

  const sorted = [...items]
    .filter((it) => it.weight > 0)
    .sort((a, b) => b.remainder - a.remainder || b.weight - a.weight || a.index - b.index);

  const result = new Array(weights.length).fill(0);
  for (const it of items) {
    result[it.index] = it.floor;
  }

  for (let i = 0; i < deficit && i < sorted.length; i++) {
    result[sorted[i].index] += 1;
  }

  return result;
}

/**
 * Computes round-off to the nearest rupee (100 paise).
 * E.g., 10040 paise -> roundOff = -40, total = 10000 paise (₹100)
 * 10060 paise -> roundOff = +40, total = 10100 paise (₹101)
 */
export function calculateRoundOff(totalPaise: number): { roundOffPaise: number; roundedTotalPaise: number } {
  const remainder = totalPaise % 100;
  if (remainder === 0) {
    return { roundOffPaise: 0, roundedTotalPaise: totalPaise };
  }

  if (remainder >= 50) {
    const roundOffPaise = 100 - remainder;
    return { roundOffPaise, roundedTotalPaise: totalPaise + roundOffPaise };
  } else {
    const roundOffPaise = -remainder;
    return { roundOffPaise, roundedTotalPaise: totalPaise + roundOffPaise };
  }
}
