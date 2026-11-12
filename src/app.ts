import './config/env';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { requestIdMiddleware } from './middlewares/requestId';
import { standardRateLimiter } from './middlewares/rateLimiter';
import { errorHandler } from './middlewares/errorHandler';

import { healthRouter } from './routes/health.routes';
import { s3Adapter } from './integrations/s3/s3.adapter';
import { authRouter } from './routes/auth.routes';
import { adminRouter } from './routes/admin.routes';
import { businessRouter } from './routes/business.routes';
import { catalogueRouter } from './routes/catalogue.routes';
import { appointmentRouter } from './routes/appointment.routes';
import { customerRouter } from './routes/customer.routes';
import { billingRouter } from './routes/billing.routes';
import { prepaidRouter } from './routes/prepaid.routes';
import { staffRouter } from './routes/staff.routes';
import { payrollRouter } from './routes/payroll.routes';
import { inventoryRouter } from './routes/inventory.routes';
import { leadRouter } from './routes/lead.routes';
import { whatsappRouter } from './routes/whatsapp.routes';
import { dayendRouter } from './routes/dayend.routes';
import { reportRouter } from './routes/report.routes';
import { auditRouter } from './routes/audit.routes';
import { notificationRouter } from './routes/notification.routes';
import { marketingRouter } from './routes/marketing.routes';


export function createApp() {
  const app = express();

  // Basic security and performance middlewares
  app.use(helmet());
  app.use(cors({ origin: true, credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Request ID and contextual child logger
  app.use(requestIdMiddleware);

  // Rate Limiting
  app.use(standardRateLimiter);

  // API Routes
  app.use(healthRouter);
  app.use('/auth', authRouter);
  app.use('/admin', adminRouter);
  app.use('/business', businessRouter);
  app.use('/customers', customerRouter);
  app.use('/staff', staffRouter);
  app.use('/leads', leadRouter);
  app.use(catalogueRouter);
  app.use(appointmentRouter);
  app.use(billingRouter);
  app.use(prepaidRouter);
  app.use(payrollRouter);
  app.use(inventoryRouter);
  app.use(whatsappRouter);
  app.use(dayendRouter);
  app.use(reportRouter);
  app.use(auditRouter);
  app.use(notificationRouter);
  app.use('/marketing', marketingRouter);

  // Local signed upload/download fallback when S3 credentials are not configured
  app.put('/uploads/local', express.raw({ type: '*/*', limit: '5mb' }), async (req, res, next) => {
    try {
      const { key, expires, sig, contentType } = req.query as Record<string, string>;
      if (!key || !expires || !sig || !s3Adapter.verifyLocalSignature('PUT', key, expires, sig, contentType)) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid or expired upload signature' } });
      }
      const bodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      await s3Adapter.uploadBuffer(key, bodyBuffer, contentType || req.headers['content-type'] || 'application/octet-stream');
      return res.status(200).json({ key, size: bodyBuffer.length });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/uploads/local', async (req, res, next) => {
    try {
      const { key, expires, sig } = req.query as Record<string, string>;
      if (!key || !expires || !sig || !s3Adapter.verifyLocalSignature('GET', key, expires, sig)) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid or expired download signature' } });
      }
      const buffer = await s3Adapter.getBuffer(key);
      if (!buffer || buffer.length === 0) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
      }
      return res.send(buffer);
    } catch (err) {
      return next(err);
    }
  });


  // 404 Handler
  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `Route not found: ${req.method} ${req.path}`,
      },
    });
  });

  // Global Error Handler
  app.use(errorHandler);

  return app;
}

export const app = createApp();
