import { Worker } from 'bullmq';
import { logger } from '../utils';
import {
  createWhatsAppWorker,
  createCampaignWorker,
  createTemplateSyncWorker,
} from './jobs/whatsapp.worker';
import { createAutomationWorker } from './jobs/automation.worker';
import { createDayEndWorker, createDailySummaryWorker } from './jobs/dayend.worker';
import {
  createPlanExpiryWorker,
  createRecurringExpenseWorker,
  createStockAlertsWorker,
  createLedgerCheckWorker,
} from './jobs/maintenance.worker';
import { createPdfWorker } from './jobs/pdf.worker';
import { setupSchedulers } from './scheduler';
import { Campaign } from '../models';
import { campaignSendQueue } from './queues';

export * from './queues';
export * from './scheduler';

let activeWorkers: Worker[] = [];
let isWorkerRunning = false;

/**
 * Initializes and starts all BullMQ background worker processors and schedules.
 */
export async function startBackgroundWorkers(): Promise<Worker[]> {
  if (isWorkerRunning && activeWorkers.length > 0) {
    logger.info('Background workers are already running');
    return activeWorkers;
  }

  logger.info('Starting Glox Salon Management background workers...');

  activeWorkers = [
    createWhatsAppWorker(),
    createCampaignWorker(),
    createTemplateSyncWorker(),
    createAutomationWorker(),
    createDayEndWorker(),
    createDailySummaryWorker(),
    createPlanExpiryWorker(),
    createRecurringExpenseWorker(),
    createStockAlertsWorker(),
    createLedgerCheckWorker(),
    createPdfWorker(),
  ];

  await setupSchedulers();

  // Optimistic startup dispatch: dispatch any overdue scheduled campaigns immediately
  try {
    const overdueCampaigns = await Campaign.find({
      status: 'scheduled',
      scheduledAt: { $lte: new Date() },
    });
    for (const c of overdueCampaigns) {
      await campaignSendQueue().add(
        'send',
        { campaignId: c._id.toString(), businessId: c.businessId.toString() },
        { jobId: `campaign_startup_${c._id}_${Date.now()}` }
      );
    }
    if (overdueCampaigns.length > 0) {
      logger.info({ count: overdueCampaigns.length }, 'Dispatched overdue scheduled campaigns on worker startup');
    }
  } catch (startupErr) {
    logger.warn({ err: startupErr }, 'Notice: Overdue scheduled campaigns dispatch on startup had error');
  }

  isWorkerRunning = true;
  logger.info(`Initialized ${activeWorkers.length} BullMQ worker processes successfully`);
  return activeWorkers;
}

/**
 * Gracefully shuts down all active BullMQ workers.
 */
export async function stopBackgroundWorkers(): Promise<void> {
  if (!isWorkerRunning || activeWorkers.length === 0) {
    return;
  }

  logger.info('Gracefully shutting down background workers...');
  for (const w of activeWorkers) {
    try {
      await w.close();
    } catch (err) {
      logger.warn({ err }, 'Error closing worker');
    }
  }
  activeWorkers = [];
  isWorkerRunning = false;
  logger.info('Background workers shutdown complete');
}

/**
 * Returns whether workers are currently active.
 */
export function areWorkersRunning(): boolean {
  return isWorkerRunning;
}
