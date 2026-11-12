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
import { logger, getBusinessDate, getDaysInMonth } from '../../utils';

export function createPlanExpiryWorker(): Worker {
  const connection = getBullConnection();

  return new Worker(
    'plan-expiry',
    async (job: Job<{ date?: string }>) => {
      const todayDateStr = job.data?.date || getBusinessDate();
      logger.info({ date: todayDateStr }, 'Running plan-expiry job');

      // Expire customer plans whose validTill is earlier than today
      const result = await CustomerPlan.updateMany(
        {
          status: 'active',
          validTill: { $lt: todayDateStr },
        },
        {
          $set: { status: 'expired' },
        }
      ).setOptions({ skipTenantScope: true });

      logger.info({ expiredCount: result.modifiedCount }, 'Customer plans expired');
    },
    { connection: connection as any }
  );
}

export function createRecurringExpenseWorker(): Worker {
  const connection = getBullConnection();

  return new Worker(
    'recurring-expense',
    async (job: Job<{ date?: string }>) => {
      const todayStr = job.data?.date || getBusinessDate();
      logger.info({ date: todayStr }, 'Running recurring-expense job');

      const [yearStr, monthStr, dayStr] = todayStr.split('-');
      const currentDay = Number(dayStr);
      const daysInMonth = getDaysInMonth(Number(yearStr), Number(monthStr));
      const currentMonthPrefix = todayStr.substring(0, 7);

      const dayCondition = currentDay === daysInMonth ? { $gte: currentDay } : currentDay;
      const activeRules = await RecurringExpense.find({
        active: true,
        dayOfMonth: dayCondition,
      }).setOptions({ skipTenantScope: true });

      for (const rule of activeRules) {
        // Check if expense already posted for this month
        const existing = await Expense.findOne({
          businessId: rule.businessId,
          recurringId: rule._id,
          businessDate: { $regex: `^${currentMonthPrefix}` },
        });

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
    async (job: Job<{ branchId?: string; date?: string }>) => {
      const todayDateStr = job.data?.date || getBusinessDate();
      logger.info({ jobData: job.data, date: todayDateStr }, 'Running stock-alerts job');

      const products = await Product.find({ active: true }).setOptions({ skipTenantScope: true });

      for (const prod of products) {
        for (const rl of prod.reorderLevels || []) {
          if (job.data?.branchId && rl.branchId.toString() !== job.data.branchId) {
            continue;
          }

          const balance = await StockBalance.findOne({
            businessId: prod.businessId,
            branchId: rl.branchId,
            productId: prod._id,
          });

          const currentQty = balance ? balance.qty : 0;
          if (currentQty <= rl.qty) {
            // Find a real user (manager for branch, branch login, or owner) to notify
            const recipient =
              (await User.findOne({
                businessId: prod.businessId,
                role: 'manager',
                branchIds: rl.branchId,
                status: 'active',
              })) ||
              (await User.findOne({
                businessId: prod.businessId,
                role: 'branch',
                branchLoginFor: rl.branchId,
                status: 'active',
              })) ||
              (await User.findOne({
                businessId: prod.businessId,
                role: 'owner',
                status: 'active',
              }));

            if (!recipient) continue;

            await Notification.create({
              businessId: prod.businessId,
              userId: recipient._id,
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
    async (job: Job<{ date?: string }>) => {
      const dateStr = job.data?.date || getBusinessDate();
      logger.info({ date: dateStr }, 'Running ledger-check job');

      const customers = await Customer.find({ walletBalancePaise: { $gt: 0 } })
        .limit(500)
        .setOptions({ skipTenantScope: true });
      for (const cust of customers) {
        const txs = await WalletLedger.find({ businessId: cust.businessId, customerId: cust._id });
        const computed = txs.reduce((acc: number, tx: any) => {
          if (['topup', 'bonus', 'refund', 'imported'].includes(tx.type)) return acc + tx.amountPaise;
          if (['redeem', 'reverse', 'expiry'].includes(tx.type)) return acc - tx.amountPaise;
          if (tx.type === 'adjust') return acc + tx.amountPaise;
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
