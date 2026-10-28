import './config/env';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { requestIdMiddleware } from './middlewares/requestId';
import { standardRateLimiter } from './middlewares/rateLimiter';
import { errorHandler } from './middlewares/errorHandler';

import { healthRouter } from './routes/health.routes';
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
import { whatsappRouter, webhookRouter } from './routes/whatsapp.routes';
import { dayendRouter } from './routes/dayend.routes';
import { reportRouter } from './routes/report.routes';
import { auditRouter } from './routes/audit.routes';
import { notificationRouter } from './routes/notification.routes';
import { env } from './config/env';

export function createApp() {
  const app = express();

  // Basic security and performance middlewares
  app.use(helmet());
  const allowedOrigins = env.APP_ORIGINS || [];
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      credentials: true,
    })
  );
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Request ID and contextual child logger
  app.use(requestIdMiddleware);

  // Rate Limiting
  app.use(standardRateLimiter);

  // Public Routes (no authentication)
  app.use(healthRouter);
  app.use(webhookRouter);

  // Authenticated API Routes
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
