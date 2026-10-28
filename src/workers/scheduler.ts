import {
  automationScanQueue,
  planExpiryQueue,
  dailySummaryQueue,
  ledgerCheckQueue,
  recurringExpenseQueue,
  stockAlertsQueue,
} from './queues';
import { logger } from '../utils';
import { Business } from '../models';

export async function setupSchedulers(): Promise<void> {
  logger.info('Initializing BullMQ recurring job schedules...');

  // Automation scan every 15 minutes
  await automationScanQueue().upsertJobScheduler(
    'automation-scan-scheduler',
    { pattern: '*/15 * * * *' },
    {
      name: 'scan',
      data: { slot: new Date().toISOString() },
    }
  );

  // Plan expiry at 00:30
  await planExpiryQueue().upsertJobScheduler(
    'plan-expiry-scheduler',
    { pattern: '30 0 * * *' },
    {
      name: 'expire',
      data: { date: new Date().toISOString().split('T')[0] },
    }
  );

  // Daily summary rebuild at 02:00
  await dailySummaryQueue().upsertJobScheduler(
    'daily-summary-scheduler',
    { pattern: '0 2 * * *' },
    {
      name: 'rebuild',
      data: { date: new Date().toISOString().split('T')[0] },
    }
  );

  // Ledger check at 03:00
  await ledgerCheckQueue().upsertJobScheduler(
    'ledger-check-scheduler',
    { pattern: '0 3 * * *' },
    {
      name: 'verify',
      data: { date: new Date().toISOString().split('T')[0] },
    }
  );

  // Recurring expense at 06:00
  await recurringExpenseQueue().upsertJobScheduler(
    'recurring-expense-scheduler',
    { pattern: '0 6 * * *' },
    {
      name: 'generate',
      data: { date: new Date().toISOString().split('T')[0] },
    }
  );

  // Stock alerts at 23:00
  await stockAlertsQueue().upsertJobScheduler(
    'stock-alerts-scheduler',
    { pattern: '0 23 * * *' },
    {
      name: 'check',
      data: { date: new Date().toISOString().split('T')[0] },
    }
  );

  logger.info('BullMQ recurring schedules registered successfully');
}
