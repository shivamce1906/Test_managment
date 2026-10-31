import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole, requireKind } from '../middlewares/role.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createCustomerSchema,
  updateCustomerSchema,
  mergeCustomerSchema,
  addServiceNoteSchema,
  listCustomersQuerySchema,
  customerHistoryQuerySchema,
  idParamSchema,
} from '../validations';
import { customerController } from '../controllers/customer.controller';

export const customerRouter = Router();

customerRouter.use(authenticate(), requireKind('tenant'));

customerRouter.post('/', validate({ body: createCustomerSchema }), customerController.createCustomer);
customerRouter.get('/', validate({ query: listCustomersQuerySchema }), customerController.getCustomers);
customerRouter.get('/export', requireRole('owner'), customerController.exportCustomers);
customerRouter.post('/merge', requireRole('owner', 'manager'), validate({ body: mergeCustomerSchema }), customerController.mergeCustomers);
customerRouter.get('/:id', validate({ params: idParamSchema }), customerController.getCustomerById);
customerRouter.patch('/:id', validate({ params: idParamSchema, body: updateCustomerSchema }), customerController.updateCustomer);
customerRouter.post('/:id/reveal', validate({ params: idParamSchema }), customerController.revealCustomer);
customerRouter.post('/:id/notes', validate({ params: idParamSchema, body: addServiceNoteSchema }), customerController.addServiceNote);
customerRouter.post('/:id/merge', requireRole('owner', 'manager'), validate({ params: idParamSchema, body: mergeCustomerSchema }), customerController.mergeCustomers);
customerRouter.get('/:id/history', validate({ params: idParamSchema, query: customerHistoryQuerySchema }), customerController.getCustomerHistory);
