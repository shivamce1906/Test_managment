import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireBranchAccess } from '../middlewares/branch.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createAppointmentSchema,
  createWalkInSchema,
  updateAppointmentStatusSchema,
} from '../validations';
import { appointmentController } from '../controllers/appointment.controller';

export const appointmentRouter = Router();

appointmentRouter.use(authenticate());

// 1. Branch scoped appointment endpoints
appointmentRouter.post('/branches/:branchId/appointments', requireBranchAccess, validate({ body: createAppointmentSchema }), appointmentController.createAppointment);
appointmentRouter.post('/branches/:branchId/walk-in', requireBranchAccess, validate({ body: createWalkInSchema }), appointmentController.createWalkIn);
appointmentRouter.get('/branches/:branchId/appointments', requireBranchAccess, appointmentController.getAppointments);

// 2. Staff Blocks
appointmentRouter.post('/branches/:branchId/staff-blocks', requireBranchAccess, appointmentController.createStaffBlock);
appointmentRouter.delete('/branches/:branchId/staff-blocks/:blockId', requireBranchAccess, appointmentController.deleteStaffBlock);

// 3. Single appointment operations
appointmentRouter.get('/appointments/:id', appointmentController.getAppointmentById);
appointmentRouter.patch('/appointments/:id/status', validate({ body: updateAppointmentStatusSchema }), appointmentController.updateStatus);
