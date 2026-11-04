import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireKind } from '../middlewares/role.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createLeadSchema,
  leadFollowUpSchema,
  leadNoteSchema,
  listLeadsQuerySchema,
  updateLeadSchema,
} from '../validations';
import { LeadController } from '../controllers/lead.controller';

export const leadRouter = Router();

leadRouter.use(authenticate(), requireKind('tenant'));

leadRouter.post('/', validate({ body: createLeadSchema }), LeadController.createLead);
leadRouter.get('/', validate({ query: listLeadsQuerySchema }), LeadController.getLeads);
leadRouter.get('/:id', LeadController.getLeadById);
leadRouter.patch('/:id', validate({ body: updateLeadSchema }), LeadController.updateLead);
leadRouter.post('/:id/follow-ups', validate({ body: leadFollowUpSchema }), LeadController.addFollowUp);
leadRouter.post('/:id/notes', validate({ body: leadNoteSchema }), LeadController.addNote);
leadRouter.post('/:id/convert', LeadController.convertLead);
