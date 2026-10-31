/**
 * Money calculations in integer paise.
 * ₹1 = 100 paise.
 * Percentages are expressed in basis points (1% = 100 bps).
 */

export function paiseToRupees(paise: number): number {
  return paise / 100;
}

export function rupeesToPaise(rupees: number): number {
  // Shift via the decimal string so 1.005 -> 100.5 (not 100.49999…) and rounds half-up to 101
  return Math.round(Number(`${rupees}e2`));
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
 * Handles rounding error by distributing the remainder to the largest component.
 */
export function distributeProRata(totalAmount: number, weights: number[]): number[] {
  const sumWeights = weights.reduce((acc, w) => acc + w, 0);
  if (sumWeights === 0 || totalAmount === 0) {
    return weights.map(() => 0);
  }

  // The rounding remainder goes to the last element that has weight, never to a zero-weight one
  let lastWeighted = weights.length - 1;
  while (lastWeighted > 0 && weights[lastWeighted] === 0) lastWeighted--;

  let allocated = 0;
  const result: number[] = [];

  for (let i = 0; i < weights.length; i++) {
    if (i === lastWeighted) {
      result.push(totalAmount - allocated);
    } else if (weights[i] === 0) {
      result.push(0);
    } else {
      const share = Math.round((totalAmount * weights[i]) / sumWeights);
      result.push(share);
      allocated += share;
    }
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
