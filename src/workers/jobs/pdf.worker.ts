import { Worker, Job } from 'bullmq';
import { getBullConnection, generateInvoicePdf, generateDayEndPdf, generatePayslipPdf, s3Adapter } from '../../integrations';
import { Bill } from '../../models';
import { logger } from '../../utils';
import { toObjectId } from '../../services';

export function createPdfWorker(): Worker {
  const connection = getBullConnection();

  return new Worker(
    'pdf-generate',
    async (job: Job<{ type: 'invoice' | 'dayend' | 'payslip'; id: string; payload: any; s3Key: string }>) => {
      const { type, id, payload, s3Key } = job.data;
      logger.info({ type, id }, 'Processing pdf-generate job');

      let pdfBuffer: Buffer;
      if (type === 'invoice') {
        pdfBuffer = await generateInvoicePdf(payload);
      } else if (type === 'dayend') {
        pdfBuffer = await generateDayEndPdf(payload);
      } else {
        pdfBuffer = await generatePayslipPdf(payload);
      }

      await s3Adapter.uploadBuffer(s3Key, pdfBuffer, 'application/pdf');
      const downloadUrl = await s3Adapter.getPresignedDownloadUrl(s3Key);

      logger.info({ type, id, s3Key }, 'PDF generated and uploaded successfully');
      return { url: downloadUrl, key: s3Key };
    },
    { connection: connection as any, concurrency: 3 }
  );
}
