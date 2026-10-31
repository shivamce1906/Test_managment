import { guardedRouter } from './guarded-router';
import { requireKind } from '../middlewares/role.middleware';
import { authenticate } from '../middlewares/auth.middleware';
import { requireBranchAccess } from '../middlewares/branch.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createAppointmentSchema,
  createWalkInSchema,
  updateAppointmentStatusSchema,
  updateAppointmentSchema,
  createStaffBlockSchema,
  listAppointmentsQuerySchema,
  availabilityQuerySchema,
  idParamSchema,
} from '../validations';
import { appointmentController } from '../controllers/appointment.controller';

export const appointmentRouter = guardedRouter(authenticate(), requireKind('tenant'));


// 1. Branch scoped appointment endpoints
appointmentRouter.post('/branches/:branchId/appointments', requireBranchAccess, validate({ body: createAppointmentSchema }), appointmentController.createAppointment);
appointmentRouter.post('/branches/:branchId/walk-in', requireBranchAccess, validate({ body: createWalkInSchema }), appointmentController.createWalkIn);
// SRS path alias
appointmentRouter.post('/branches/:branchId/appointments/walk-in', requireBranchAccess, validate({ body: createWalkInSchema }), appointmentController.createWalkIn);
appointmentRouter.get('/branches/:branchId/appointments', requireBranchAccess, validate({ query: listAppointmentsQuerySchema }), appointmentController.getAppointments);
appointmentRouter.get('/branches/:branchId/availability', requireBranchAccess, validate({ query: availabilityQuerySchema }), appointmentController.getAvailability);

// 2. Staff Blocks
appointmentRouter.post('/branches/:branchId/staff-blocks', requireBranchAccess, validate({ body: createStaffBlockSchema }), appointmentController.createStaffBlock);
appointmentRouter.delete('/branches/:branchId/staff-blocks/:blockId', requireBranchAccess, appointmentController.deleteStaffBlock);

// 3. Single appointment operations
appointmentRouter.get('/appointments/:id', validate({ params: idParamSchema }), appointmentController.getAppointmentById);
appointmentRouter.patch('/appointments/:id', validate({ params: idParamSchema, body: updateAppointmentSchema }), appointmentController.reschedule);
appointmentRouter.patch('/appointments/:id/status', validate({ params: idParamSchema, body: updateAppointmentStatusSchema }), appointmentController.updateStatus);
// SRS uses POST for status changes
appointmentRouter.post('/appointments/:id/status', validate({ params: idParamSchema, body: updateAppointmentStatusSchema }), appointmentController.updateStatus);
