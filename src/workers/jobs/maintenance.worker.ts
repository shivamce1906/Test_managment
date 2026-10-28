import { Worker, Job } from 'bullmq';
import { getBullConnection } from '../../integrations';
import {
  CustomerPlan,
  Customer,
  WalletLedger,
  RecurringExpense,
  Expense,
  Product,
  StockBalance,
  Notification,
  User,
} from '../../models';
import { logger } from '../../utils';
import { toObjectId } from '../../services';

export function createPlanExpiryWorker(): Worker {
  const connection = getBullConnection();

  return new Worker(
    'plan-expiry',
    async (job: Job<{ date: string }>) => {
      logger.info({ date: job.data.date }, 'Running plan-expiry job');
      const todayDateStr = job.data.date || new Date().toISOString().split('T')[0];

      // Expire customer plans whose validTill is earlier than today
      const result = await CustomerPlan.updateMany(
        {
          status: 'active',
          validTill: { $lt: todayDateStr },
        },
        {
          $set: { status: 'expired' },
        },
        { skipTenantScope: true } as any
      );

      logger.info({ expiredCount: result.modifiedCount }, 'Customer plans expired');
    },
    { connection: connection as any }
  );
}

export function createRecurringExpenseWorker(): Worker {
  const connection = getBullConnection();

  return new Worker(
    'recurring-expense',
    async (job: Job<{ date: string }>) => {
      logger.info({ date: job.data.date }, 'Running recurring-expense job');
      const now = new Date();
      const todayStr = job.data.date || now.toISOString().split('T')[0];
      const currentDay = job.data.date ? parseInt(todayStr.slice(8, 10), 10) : now.getDate();
      const currentMonthPrefix = todayStr.substring(0, 7);

      const activeRules = await RecurringExpense.find(
        {
          active: true,
          dayOfMonth: currentDay,
        },
        null,
        { skipTenantScope: true }
      );

      for (const rule of activeRules) {
        // Check if expense already posted for this month
        const existing = await Expense.findOne(
          {
            recurringId: rule._id,
            businessDate: { $regex: `^${currentMonthPrefix}` },
          },
          null,
          { skipTenantScope: true }
        );

        if (existing) continue;

        await Expense.create({
          businessId: rule.businessId,
          branchId: rule.branchId,
          recurringId: rule._id,
          category: rule.category as any,
          amountPaise: rule.amountPaise,
          businessDate: todayStr,
          mode: 'bank',
          paidFrom: 'bank',
          note: `Auto-generated recurring expense`,
        });
      }
    },
    { connection: connection as any }
  );
}

export function createStockAlertsWorker(): Worker {
  const connection = getBullConnection();

  return new Worker(
    'stock-alerts',
    async (job: Job<{ branchId?: string; date: string }>) => {
      logger.info({ jobData: job.data }, 'Running stock-alerts job');

      const filter: any = { active: true };
      const products = await Product.find(filter, null, { skipTenantScope: true });

      for (const prod of products) {
        for (const rl of prod.reorderLevels || []) {
          if (job.data.branchId && rl.branchId.toString() !== job.data.branchId) {
            continue;
          }

          const balance = await StockBalance.findOne(
            {
              businessId: prod.businessId,
              branchId: rl.branchId,
              productId: prod._id,
            },
            null,
            { skipTenantScope: true }
          );

          const currentQty = balance ? balance.qty : 0;
          if (currentQty <= rl.qty) {
            // Find an owner or manager to notify
            const recipientUser = await User.findOne(
              {
                businessId: prod.businessId,
                role: { $in: ['owner', 'manager', 'branch'] },
                status: 'active',
              },
              null,
              { skipTenantScope: true }
            );

            await Notification.create({
              businessId: prod.businessId,
              userId: recipientUser ? recipientUser._id : prod.businessId,
              type: 'low_stock',
              title: `Low Stock Alert: ${prod.name}`,
              body: `Current stock (${currentQty}) is at or below reorder level (${rl.qty}).`,
              readAt: undefined,
            });
          }
        }
      }
    },
    { connection: connection as any }
  );
}

export function createLedgerCheckWorker(): Worker {
  const connection = getBullConnection();

  return new Worker(
    'ledger-check',
    async (job: Job<{ date: string }>) => {
      logger.info({ date: job.data.date }, 'Running ledger-check job');

      const customers = await Customer.find(
        { walletBalancePaise: { $gt: 0 } },
        null,
        { skipTenantScope: true }
      ).limit(500);
      for (const cust of customers) {
        const txs = await WalletLedger.find(
          { customerId: cust._id },
          null,
          { skipTenantScope: true }
        );
        const computed = txs.reduce((acc: number, tx: any) => {
          if (['topup', 'bonus', 'refund'].includes(tx.type)) return acc + tx.amountPaise;
          if (['redeem', 'reverse', 'expiry'].includes(tx.type)) return acc - tx.amountPaise;
          return acc;
        }, 0);

        if (computed !== cust.walletBalancePaise) {
          logger.error(
            { customerId: cust._id, stored: cust.walletBalancePaise, computed },
            'CRITICAL: Customer wallet ledger balance mismatch detected!'
          );
        }
      }
    },
    { connection: connection as any }
  );
}
