import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { NotificationController } from '../controllers/notification.controller';

export const notificationRouter = Router();

notificationRouter.use(authenticate());

// 1. In-App Notifications
notificationRouter.get('/notifications', NotificationController.getNotifications);
notificationRouter.patch('/notifications/:id/read', NotificationController.markRead);
notificationRouter.post('/notifications/read-all', NotificationController.markAllRead);

// 2. Real-Time Scope Change Polling (GET /changes)
notificationRouter.get('/changes', NotificationController.getChanges);

// 3. S3 Upload Presigned URL
notificationRouter.post('/uploads/presign', NotificationController.presignUpload);
