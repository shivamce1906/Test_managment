import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createLeadSchema,
  updateLeadSchema,
} from '../validations';
import { LeadController } from '../controllers/lead.controller';

export const leadRouter = Router();

leadRouter.use(authenticate());

leadRouter.post('/', validate({ body: createLeadSchema }), LeadController.createLead);
leadRouter.get('/', LeadController.getLeads);
leadRouter.get('/:id', LeadController.getLeadById);
leadRouter.patch('/:id', validate({ body: updateLeadSchema }), LeadController.updateLead);
leadRouter.post('/:id/convert', LeadController.convertLead);
