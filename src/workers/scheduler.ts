import {
  automationScanQueue,
  planExpiryQueue,
  dailySummaryQueue,
  ledgerCheckQueue,
  recurringExpenseQueue,
  stockAlertsQueue,
  dayEndReportQueue,
} from './queues';
import { logger } from '../utils';

export async function setupSchedulers(): Promise<void> {
  logger.info('Initializing BullMQ recurring job schedules (Asia/Kolkata)...');

  // Automation scan every 5 minutes (IST)
  await automationScanQueue().upsertJobScheduler(
    'automation-scan-scheduler',
    { pattern: '*/5 * * * *', tz: 'Asia/Kolkata' },
    {
      name: 'scan',
      data: { scheduled: true },
    }
  );

  // Plan expiry at 00:30 IST
  await planExpiryQueue().upsertJobScheduler(
    'plan-expiry-scheduler',
    { pattern: '30 0 * * *', tz: 'Asia/Kolkata' },
    {
      name: 'expire',
      data: {},
    }
  );

  // Daily summary rebuild at 02:00 IST
  await dailySummaryQueue().upsertJobScheduler(
    'daily-summary-scheduler',
    { pattern: '0 2 * * *', tz: 'Asia/Kolkata' },
    {
      name: 'rebuild',
      data: {},
    }
  );

  // Ledger check at 03:00 IST
  await ledgerCheckQueue().upsertJobScheduler(
    'ledger-check-scheduler',
    { pattern: '0 3 * * *', tz: 'Asia/Kolkata' },
    {
      name: 'verify',
      data: {},
    }
  );

  // Recurring expense at 06:00 IST
  await recurringExpenseQueue().upsertJobScheduler(
    'recurring-expense-scheduler',
    { pattern: '0 6 * * *', tz: 'Asia/Kolkata' },
    {
      name: 'generate',
      data: {},
    }
  );

  // Stock alerts at 23:00 IST
  await stockAlertsQueue().upsertJobScheduler(
    'stock-alerts-scheduler',
    { pattern: '0 23 * * *', tz: 'Asia/Kolkata' },
    {
      name: 'check',
      data: {},
    }
  );

  // Day-End report dispatcher every 15 minutes IST so each business receives its report at its configured dayEndReportTime
  await dayEndReportQueue().upsertJobScheduler(
    'day-end-report-scheduler',
    { pattern: '*/15 * * * *', tz: 'Asia/Kolkata' },
    {
      name: 'report',
      data: { scheduled: true },
    }
  );

  logger.info('BullMQ recurring schedules registered successfully');
}
