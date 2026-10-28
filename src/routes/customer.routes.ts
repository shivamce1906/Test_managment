import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole, requireKind } from '../middlewares/role.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createCustomerSchema,
  updateCustomerSchema,
  mergeCustomerSchema,
  addServiceNoteSchema,
} from '../validations';
import { customerController } from '../controllers/customer.controller';

export const customerRouter = Router();

customerRouter.use(authenticate(), requireKind('tenant'));

customerRouter.post('/', validate({ body: createCustomerSchema }), customerController.createCustomer);
customerRouter.get('/', customerController.getCustomers);
customerRouter.get('/export', requireRole('owner'), customerController.exportCustomers);
customerRouter.post('/merge', requireRole('owner', 'manager'), validate({ body: mergeCustomerSchema }), customerController.mergeCustomers);
customerRouter.get('/:id', customerController.getCustomerById);
customerRouter.patch('/:id', validate({ body: updateCustomerSchema }), customerController.updateCustomer);
customerRouter.post('/:id/reveal', customerController.revealCustomer);
customerRouter.post('/:id/notes', validate({ body: addServiceNoteSchema }), customerController.addServiceNote);
customerRouter.get('/:id/history', customerController.getCustomerHistory);
