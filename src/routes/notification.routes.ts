import { z } from 'zod';
import { guardedRouter } from './guarded-router';
import { requireKind } from '../middlewares/role.middleware';
import { authenticate } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import { NotificationController } from '../controllers/notification.controller';

const ALLOWED_UPLOAD_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

const presignUploadSchema = z.object({
  kind: z.enum(['receipt', 'logo', 'media', 'import', 'avatar', 'attachment']).optional(),
  filename: z.string().trim().min(1).max(200).optional(),
  contentType: z
    .string()
    .trim()
    .refine((v) => ALLOWED_UPLOAD_CONTENT_TYPES.has(v.toLowerCase()), 'Disallowed file contentType'),
});

export const notificationRouter = guardedRouter(authenticate(), requireKind('tenant'));


// 1. In-App Notifications
notificationRouter.get('/notifications', NotificationController.getNotifications);
notificationRouter.patch('/notifications/:id/read', NotificationController.markRead);
notificationRouter.post('/notifications/read-all', NotificationController.markAllRead);

// 2. Real-Time Scope Change Polling (GET /changes)
notificationRouter.get('/changes', NotificationController.getChanges);

// 3. S3 Upload Presigned URL
notificationRouter.post('/uploads/presign', validate({ body: presignUploadSchema }), NotificationController.presignUpload);
