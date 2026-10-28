import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireBranchAccess } from '../middlewares/branch.middleware';
import { requireKind } from '../middlewares/role.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createAppointmentSchema,
  createWalkInSchema,
  updateAppointmentStatusSchema,
  updateAppointmentSchema,
  createStaffBlockSchema,
} from '../validations';
import { appointmentController } from '../controllers/appointment.controller';

export const appointmentRouter = Router();

appointmentRouter.use(authenticate(), requireKind('tenant'));

// 1. Branch scoped appointment endpoints
appointmentRouter.post('/branches/:branchId/appointments', requireBranchAccess, validate({ body: createAppointmentSchema }), appointmentController.createAppointment);
appointmentRouter.post('/branches/:branchId/walk-in', requireBranchAccess, validate({ body: createWalkInSchema }), appointmentController.createWalkIn);
appointmentRouter.get('/branches/:branchId/appointments', requireBranchAccess, appointmentController.getAppointments);
appointmentRouter.get('/branches/:branchId/availability', requireBranchAccess, appointmentController.getBranchAvailability);

// 2. Staff Blocks
appointmentRouter.post('/branches/:branchId/staff-blocks', requireBranchAccess, validate({ body: createStaffBlockSchema }), appointmentController.createStaffBlock);
appointmentRouter.delete('/branches/:branchId/staff-blocks/:blockId', requireBranchAccess, appointmentController.deleteStaffBlock);

// 3. Single appointment operations
appointmentRouter.get('/appointments/:id', appointmentController.getAppointmentById);
appointmentRouter.patch('/appointments/:id', validate({ body: updateAppointmentSchema }), appointmentController.rescheduleAppointment);
appointmentRouter.patch('/appointments/:id/status', validate({ body: updateAppointmentStatusSchema }), appointmentController.updateStatus);
