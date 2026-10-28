import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole, requireKind } from '../middlewares/role.middleware';
import { requireBranchAccess } from '../middlewares/branch.middleware';
import { requirePermission } from '../middlewares/permission.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createStaffSchema,
  updateStaffSchema,
  updateRosterSchema,
  markAttendanceSchema,
  createLeaveSchema,
  updateLeaveStatusSchema,
  createAdvanceSchema,
} from '../validations';
import { StaffController } from '../controllers/staff.controller';

export const staffRouter = Router();

staffRouter.use(authenticate(), requireKind('tenant'));

// 1. Staff Master CRUD
staffRouter.post('/', requireRole('owner', 'manager'), requirePermission('manageStaff'), validate({ body: createStaffSchema }), StaffController.createStaff);
staffRouter.get('/', StaffController.getStaffList);
staffRouter.get('/:id', StaffController.getStaffById);
staffRouter.patch('/:id', requireRole('owner', 'manager'), requirePermission('manageStaff'), validate({ body: updateStaffSchema }), StaffController.updateStaff);

// 2. Staff Roster
staffRouter.get('/:id/roster', StaffController.getRoster);
staffRouter.patch('/:id/roster', requireRole('owner', 'manager'), validate({ body: updateRosterSchema }), StaffController.updateRoster);

// 3. Branch Attendance
staffRouter.get('/branches/:branchId/attendance', requireBranchAccess, StaffController.getAttendance);
staffRouter.post('/branches/:branchId/attendance', requireBranchAccess, requirePermission('markAttendance'), validate({ body: markAttendanceSchema }), StaffController.markAttendance);

// 4. Leaves (PRD §3: Branch login can only VIEW, Owner/Manager can request)
staffRouter.get('/branches/:branchId/leaves', requireBranchAccess, StaffController.getLeaves);
staffRouter.post('/branches/:branchId/leaves', requireBranchAccess, requireRole('owner', 'manager'), validate({ body: createLeaveSchema }), StaffController.createLeave);
staffRouter.patch('/leaves/:id/status', requireRole('owner', 'manager'), validate({ body: updateLeaveStatusSchema }), StaffController.updateLeaveStatus);

// 5. Salary Advances
staffRouter.get('/branches/:branchId/advances', requireBranchAccess, StaffController.getAdvances);
staffRouter.post('/branches/:branchId/advances', requireBranchAccess, requireRole('owner', 'manager'), validate({ body: createAdvanceSchema }), StaffController.createAdvance);

// 6. Active Receptionists for Billed-By
staffRouter.get('/branches/:branchId/billed-by', requireBranchAccess, StaffController.getBilledBy);
