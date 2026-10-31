import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole, requireKind } from '../middlewares/role.middleware';
import { requireBranchAccess } from '../middlewares/branch.middleware';
import { requirePermission, requireBranchLoginPermission } from '../middlewares/permission.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createStaffSchema,
  updateStaffSchema,
  updateRosterSchema,
  markAttendanceSchema,
  createLeaveSchema,
  updateLeaveStatusSchema,
  createAdvanceSchema,
  listStaffQuerySchema,
  businessDateQuerySchema,
  idParamSchema,
} from '../validations';
import { StaffController } from '../controllers/staff.controller';

export const staffRouter = Router();

staffRouter.use(authenticate(), requireKind('tenant'));

// 1. Staff Master CRUD
staffRouter.post('/', requireRole('owner', 'manager'), requirePermission('manageStaff'), validate({ body: createStaffSchema }), StaffController.createStaff);
staffRouter.get('/', validate({ query: listStaffQuerySchema }), StaffController.getStaffList);
staffRouter.get('/:id', validate({ params: idParamSchema }), StaffController.getStaffById);
staffRouter.patch('/:id', requireRole('owner', 'manager'), requirePermission('manageStaff'), validate({ params: idParamSchema, body: updateStaffSchema }), StaffController.updateStaff);

// 2. Staff Roster
staffRouter.get('/:id/roster', validate({ params: idParamSchema }), StaffController.getRoster);
staffRouter.patch('/:id/roster', requireRole('owner', 'manager'), validate({ params: idParamSchema, body: updateRosterSchema }), StaffController.updateRoster);

// 3. Branch Attendance
staffRouter.get('/branches/:branchId/attendance', requireBranchAccess, validate({ query: businessDateQuerySchema }), StaffController.getAttendance);
staffRouter.post('/branches/:branchId/attendance', requireBranchAccess, requireBranchLoginPermission('markAttendance'), validate({ body: markAttendanceSchema }), StaffController.markAttendance);

// 4. Leaves
staffRouter.get('/branches/:branchId/leaves', requireBranchAccess, StaffController.getLeaves);
staffRouter.post('/branches/:branchId/leaves', requireBranchAccess, requireRole('owner', 'manager'), validate({ body: createLeaveSchema }), StaffController.createLeave);
staffRouter.patch('/leaves/:id/status', requireRole('owner', 'manager'), validate({ params: idParamSchema, body: updateLeaveStatusSchema }), StaffController.updateLeaveStatus);

// 5. Salary Advances
staffRouter.get('/branches/:branchId/advances', requireBranchAccess, StaffController.getAdvances);
staffRouter.post('/branches/:branchId/advances', requireBranchAccess, requireRole('owner', 'manager'), validate({ body: createAdvanceSchema }), StaffController.createAdvance);

// 6. Active Receptionists for Billed-By
staffRouter.get('/branches/:branchId/billed-by', requireBranchAccess, StaffController.getBilledBy);
