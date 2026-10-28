import { Queue, QueueOptions } from 'bullmq';
import { getBullConnection } from '../integrations';

const queueCache = new Map<string, Queue>();

export function getQueue(queueName: string, opts?: Partial<QueueOptions>): Queue {
  if (!queueCache.has(queueName)) {
    const connection = getBullConnection();
    const queue = new Queue(queueName, {
      connection: connection as any,
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 5000,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      },
      ...opts,
    });
    queueCache.set(queueName, queue);
  }
  return queueCache.get(queueName)!;
}

export const whatsappSendQueue = () => getQueue('whatsapp-send');
export const whatsappWebhookQueue = () => getQueue('whatsapp-webhook');
export const automationScanQueue = () => getQueue('automation-scan');
export const dayEndReportQueue = () => getQueue('day-end-report');
export const dailySummaryQueue = () => getQueue('daily-summary');
export const ledgerCheckQueue = () => getQueue('ledger-check');
export const planExpiryQueue = () => getQueue('plan-expiry');
export const recurringExpenseQueue = () => getQueue('recurring-expense');
export const stockAlertsQueue = () => getQueue('stock-alerts');
export const pdfGenerateQueue = () => getQueue('pdf-generate');
export const payrollDraftQueue = () => getQueue('payroll-draft');
export const campaignSendQueue = () => getQueue('campaign-send');
export const importQueue = () => getQueue('import');
export const templateSyncQueue = () => getQueue('template-sync');
