import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World } from '../helpers/factory';
import { Product, Vendor, StockBalance } from '../../src/models';

describe('Real-World Integration Test: Both Product Inventory Sync', () => {
  useTestDb();
  let w: World;

  beforeEach(async () => {
    w = await seedWorld();
  });

  it('purchasing a product of type both updates both retail and consumable stock balances', async () => {
    // 1. Create a Product with type: 'both'
    const product = await Product.create({
      businessId: w.business._id,
      name: 'Loreal Moroccan Argan Serum',
      brand: 'Loreal',
      category: 'Hair Care',
      type: 'both',
      sku: 'SERUM-BOTH-001',
      purchaseUnit: 'bottle',
      useUnit: 'bottle',
      unitsPerPurchase: 1,
      mrpPaise: 80000,
      sellingPricePaise: 80000,
      purchasePricePaise: 50000,
      active: true,
      branchScope: [w.branchA._id],
    });

    const vendor = await Vendor.create({
      businessId: w.business._id,
      name: 'Beauty Supply Distributor',
    });

    // 2. Create and approve a Purchase Order for 10 bottles
    const poRes = await as(w.tokens.owner).post('/purchase-orders', {
      branchId: w.branchA._id.toString(),
      vendorId: vendor._id.toString(),
      items: [
        {
          productId: product._id.toString(),
          qtyPurchaseUnits: 10,
          ratePaise: 50000,
        },
      ],
    });
    expect(poRes.status).toBe(201);
    const poId = poRes.body._id;

    // Owner/Manager decides to approve the PO
    const approveRes = await as(w.tokens.owner).post(`/purchase-orders/${poId}/decide`, {
      decision: 'approve',
    });
    expect(approveRes.status).toBe(200);

    // 3. Receive the Purchase Order without pool specified (standard dashboard stocking)
    const receiveRes = await as(w.tokens.owner).post(`/purchase-orders/${poId}/receive`, {
      items: [
        {
          productId: product._id.toString(),
          qty: 10,
        },
      ],
    });
    expect(receiveRes.status).toBe(200);

    // 4. Verify Retail Stock Query returns 10
    const retailStockRes = await as(w.tokens.owner).get(
      `/branches/${w.branchA._id}/stock?pool=retail`
    );
    expect(retailStockRes.status).toBe(200);
    const retailItem = retailStockRes.body.find(
      (b: any) => b.productId._id.toString() === product._id.toString()
    );
    expect(retailItem).toBeTruthy();
    expect(retailItem.qty).toBe(10);

    // 5. Verify Consumable Stock Query returns 10 (FIXED: was 0 before)
    const consumableStockRes = await as(w.tokens.owner).get(
      `/branches/${w.branchA._id}/stock?pool=consumable`
    );
    expect(consumableStockRes.status).toBe(200);
    const consumableItem = consumableStockRes.body.find(
      (b: any) => b.productId._id.toString() === product._id.toString()
    );
    expect(consumableItem).toBeTruthy();
    expect(consumableItem.qty).toBe(10);

    // 6. Verify direct database records
    const retailBalance = await StockBalance.findOne({
      businessId: w.business._id,
      branchId: w.branchA._id,
      productId: product._id,
      pool: 'retail',
    });
    const consumableBalance = await StockBalance.findOne({
      businessId: w.business._id,
      branchId: w.branchA._id,
      productId: product._id,
      pool: 'consumable',
    });
    expect(retailBalance).toBeTruthy();
    expect(retailBalance!.qty).toBe(10);
    expect(consumableBalance).toBeTruthy();
    expect(consumableBalance!.qty).toBe(10);
  });

  it('retail sale of both product decrements both retail and consumable pools', async () => {
    const product = await Product.create({
      businessId: w.business._id,
      name: 'Loreal Dual Shampoo',
      type: 'both',
      purchaseUnit: 'bottle',
      useUnit: 'bottle',
      unitsPerPurchase: 1,
      mrpPaise: 60000,
      sellingPricePaise: 60000,
      purchasePricePaise: 40000,
      active: true,
    });

    // Seed stock: 10 units in both pools
    await StockBalance.create({
      businessId: w.business._id,
      branchId: w.branchA._id,
      productId: product._id,
      pool: 'retail',
      qty: 10,
    });
    await StockBalance.create({
      businessId: w.business._id,
      branchId: w.branchA._id,
      productId: product._id,
      pool: 'consumable',
      qty: 10,
    });

    // Sell 2 units in retail
    const billRes = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(),
      billedByStaffId: w.receptionist._id.toString(),
      lines: [
        {
          kind: 'product',
          refId: product._id.toString(),
          qty: 2,
          staff: [{ staffId: w.stylist1._id.toString(), splitBps: 10000 }],
        },
      ],
      payments: [{ mode: 'cash', amountPaise: 141600 }], // 2 * 600 + 18% GST = 1416
    });
    expect(billRes.status).toBe(201);

    // Verify both pools are decremented to 8
    const rBal = await StockBalance.findOne({
      businessId: w.business._id,
      branchId: w.branchA._id,
      productId: product._id,
      pool: 'retail',
    });
    const cBal = await StockBalance.findOne({
      businessId: w.business._id,
      branchId: w.branchA._id,
      productId: product._id,
      pool: 'consumable',
    });

    expect(rBal!.qty).toBe(8);
    expect(cBal!.qty).toBe(8);
  });
});
