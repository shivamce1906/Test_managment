import {
  calculateBps,
  splitGst,
  distributeProRata,
  calculateRoundOff,
  rupeesToPaise,
  paiseToRupees,
} from '../../src/utils/money';

describe('money utils (BR-01: integer paise, bps)', () => {
  describe('calculateBps', () => {
    it('computes 18% of ₹1,000', () => {
      expect(calculateBps(100000, 1800)).toBe(18000);
    });
    it('returns 0 for zero amount or zero rate', () => {
      expect(calculateBps(0, 1800)).toBe(0);
      expect(calculateBps(100000, 0)).toBe(0);
    });
    it('rounds to nearest paisa (half-up)', () => {
      expect(calculateBps(25, 1800)).toBe(5); // 4.5 -> 5
      expect(calculateBps(1, 5000)).toBe(1); // 0.5 -> 1
    });
    it('always returns an integer', () => {
      for (const amt of [1, 7, 33, 99, 101, 12345, 999999]) {
        for (const bps of [1, 250, 500, 1200, 1800, 2800, 9999]) {
          expect(Number.isInteger(calculateBps(amt, bps))).toBe(true);
        }
      }
    });
    it('stays exact for large amounts (₹1 crore)', () => {
      expect(calculateBps(1_000_000_000, 1800)).toBe(180_000_000);
    });
  });

  describe('splitGst', () => {
    it('splits 18% into 9% CGST + 9% SGST', () => {
      expect(splitGst(100000, 1800)).toEqual({ cgstPaise: 9000, sgstPaise: 9000, totalGstPaise: 18000 });
    });
    it('CGST always equals SGST', () => {
      for (const t of [1, 3, 99, 1001, 2525, 77777]) {
        const g = splitGst(t, 1800);
        expect(g.cgstPaise).toBe(g.sgstPaise);
      }
    });
    it('returns zero tax for non-positive taxable value', () => {
      expect(splitGst(0, 1800).totalGstPaise).toBe(0);
      expect(splitGst(-500, 1800).totalGstPaise).toBe(0);
    });
    it('handles 5% and 12% product slabs', () => {
      expect(splitGst(100000, 500).totalGstPaise).toBe(5000);
      expect(splitGst(100000, 1200).totalGstPaise).toBe(12000);
    });
  });

  describe('distributeProRata', () => {
    it('shares always sum exactly to the total', () => {
      const cases: [number, number[]][] = [
        [100, [1, 1, 1]],
        [1, [1, 1, 1, 1]],
        [9999, [3, 7, 11]],
        [12345, [100000, 250000, 50000]],
        [7, [5, 5]],
      ];
      for (const [total, weights] of cases) {
        const shares = distributeProRata(total, weights);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      }
    });
    it('returns zeros when weights or total are zero', () => {
      expect(distributeProRata(0, [1, 2])).toEqual([0, 0]);
      expect(distributeProRata(100, [0, 0])).toEqual([0, 0]);
    });
    it('is proportional to weights', () => {
      expect(distributeProRata(300, [1, 2])).toEqual([100, 200]);
    });
    it('EDGE: never allocates a negative share', () => {
      // A zero-weight item (e.g. a package-redeemed bill line) placed last
      const shares = distributeProRata(3, [1, 1, 0]);
      shares.forEach((s) => expect(s).toBeGreaterThanOrEqual(0));
    });
    it('EDGE: zero-weight items get exactly zero', () => {
      const shares = distributeProRata(3, [1, 1, 0]);
      expect(shares[2]).toBe(0);
    });
  });

  describe('calculateRoundOff (nearest rupee, half-up)', () => {
    it('no round-off when already whole rupees', () => {
      expect(calculateRoundOff(118000)).toEqual({ roundOffPaise: 0, roundedTotalPaise: 118000 });
    });
    it('rounds down below 50 paise', () => {
      expect(calculateRoundOff(10049)).toEqual({ roundOffPaise: -49, roundedTotalPaise: 10000 });
    });
    it('rounds up at exactly 50 paise', () => {
      expect(calculateRoundOff(10050)).toEqual({ roundOffPaise: 50, roundedTotalPaise: 10100 });
    });
    it('rounds up above 50 paise', () => {
      expect(calculateRoundOff(10099)).toEqual({ roundOffPaise: 1, roundedTotalPaise: 10100 });
    });
    it('handles zero', () => {
      expect(calculateRoundOff(0)).toEqual({ roundOffPaise: 0, roundedTotalPaise: 0 });
    });
  });

  describe('rupee/paise conversion', () => {
    it('converts both ways', () => {
      expect(rupeesToPaise(1180)).toBe(118000);
      expect(paiseToRupees(118000)).toBe(1180);
    });
    it('EDGE: half-paisa rupee input rounds half-up (₹1.005 -> 101 paise)', () => {
      expect(rupeesToPaise(1.005)).toBe(101);
    });
  });
});
