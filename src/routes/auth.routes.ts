import { Router } from 'express';
import { loginSchema, refreshTokenSchema } from '../validations';
import { validate } from '../middlewares/validate.middleware';
import { authenticate } from '../middlewares/auth.middleware';
import { authRateLimiter } from '../middlewares/rateLimiter';
import { authController } from '../controllers/auth.controller';

export const authRouter = Router();

authRouter.post('/login', authRateLimiter, validate({ body: loginSchema }), authController.login);
authRouter.post('/refresh', validate({ body: refreshTokenSchema }), authController.refresh);
authRouter.post('/logout', authenticate(), authController.logout);
authRouter.get('/me', authenticate(), authController.me);
