import { Router } from 'express';
import { HealthController } from '../controllers/health.controller';

export const healthRouter = Router();

healthRouter.get('/health', HealthController.getHealth);
healthRouter.get('/ready', HealthController.getReady);
