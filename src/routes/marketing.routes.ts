import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole, requireKind } from '../middlewares/role.middleware';
import { requirePermission } from '../middlewares/permission.middleware';
import { validate } from '../middlewares/validate.middleware';
import {
  createSegmentSchema,
  updateSegmentSchema,
  previewSegmentSchema,
  previewSegmentCustomersSchema,
  createOfferSchema,
  updateOfferSchema,
  validateOfferSchema,
  createMarketingCampaignSchema,
  updateMarketingCampaignSchema,
  scheduleCampaignSchema,
  idParamSchema,
  paginationQuerySchema,
} from '../validations';
import { MarketingController } from '../controllers/marketing.controller';

export const marketingRouter = Router();

// Base tenant authentication
marketingRouter.use(authenticate(), requireKind('tenant'));

// ----------------------------------------------------
// 1. Promotional Offers
// ----------------------------------------------------
// Validation endpoint accessible to branch front-desk, managers, and owners
marketingRouter.post(
  '/offers/validate',
  validate({ body: validateOfferSchema }),
  MarketingController.validateOffer
);

marketingRouter.get('/offers', requireRole('owner', 'manager'), MarketingController.getOffers);
marketingRouter.get(
  '/offers/:id',
  requireRole('owner', 'manager'),
  validate({ params: idParamSchema }),
  MarketingController.getOfferById
);
marketingRouter.post(
  '/offers',
  requireRole('owner', 'manager'),
  requirePermission('manageMarketing'),
  validate({ body: createOfferSchema }),
  MarketingController.createOffer
);
marketingRouter.patch(
  '/offers/:id',
  requireRole('owner', 'manager'),
  requirePermission('manageMarketing'),
  validate({ params: idParamSchema, body: updateOfferSchema }),
  MarketingController.updateOffer
);
marketingRouter.delete(
  '/offers/:id',
  requireRole('owner', 'manager'),
  requirePermission('manageMarketing'),
  validate({ params: idParamSchema }),
  MarketingController.deleteOffer
);

// ----------------------------------------------------
// 2. Customer Segmentation
// ----------------------------------------------------
marketingRouter.get('/segments', requireRole('owner', 'manager'), MarketingController.getSegments);
marketingRouter.post(
  '/segments/preview',
  requireRole('owner', 'manager'),
  validate({ body: previewSegmentSchema }),
  MarketingController.previewSegment
);
marketingRouter.post(
  '/segments/preview/customers',
  requireRole('owner', 'manager'),
  validate({ body: previewSegmentCustomersSchema }),
  MarketingController.previewSegmentCustomers
);
marketingRouter.get(
  '/segments/:id',
  requireRole('owner', 'manager'),
  validate({ params: idParamSchema }),
  MarketingController.getSegmentById
);
marketingRouter.get(
  '/segments/:id/customers',
  requireRole('owner', 'manager'),
  validate({ params: idParamSchema, query: paginationQuerySchema }),
  MarketingController.getSegmentCustomers
);
marketingRouter.post(
  '/segments',
  requireRole('owner', 'manager'),
  requirePermission('manageMarketing'),
  validate({ body: createSegmentSchema }),
  MarketingController.createSegment
);
marketingRouter.patch(
  '/segments/:id',
  requireRole('owner', 'manager'),
  requirePermission('manageMarketing'),
  validate({ params: idParamSchema, body: updateSegmentSchema }),
  MarketingController.updateSegment
);
marketingRouter.delete(
  '/segments/:id',
  requireRole('owner', 'manager'),
  requirePermission('manageMarketing'),
  validate({ params: idParamSchema }),
  MarketingController.deleteSegment
);

// ----------------------------------------------------
// 3. Campaigns
// ----------------------------------------------------
marketingRouter.get('/campaigns', requireRole('owner', 'manager'), MarketingController.getCampaigns);
marketingRouter.get(
  '/campaigns/:id',
  requireRole('owner', 'manager'),
  validate({ params: idParamSchema }),
  MarketingController.getCampaignById
);
marketingRouter.get(
  '/campaigns/:id/analytics',
  requireRole('owner', 'manager'),
  validate({ params: idParamSchema }),
  MarketingController.getCampaignAnalytics
);
marketingRouter.post(
  '/campaigns',
  requireRole('owner', 'manager'),
  requirePermission('manageMarketing'),
  validate({ body: createMarketingCampaignSchema }),
  MarketingController.createCampaign
);
marketingRouter.patch(
  '/campaigns/:id',
  requireRole('owner', 'manager'),
  requirePermission('manageMarketing'),
  validate({ params: idParamSchema, body: updateMarketingCampaignSchema }),
  MarketingController.updateCampaign
);
marketingRouter.post(
  '/campaigns/:id/schedule',
  requireRole('owner', 'manager'),
  requirePermission('manageMarketing'),
  validate({ params: idParamSchema, body: scheduleCampaignSchema }),
  MarketingController.scheduleCampaign
);
marketingRouter.post(
  '/campaigns/:id/send',
  requireRole('owner', 'manager'),
  requirePermission('manageMarketing'),
  validate({ params: idParamSchema }),
  MarketingController.sendCampaignNow
);
marketingRouter.post(
  '/campaigns/:id/pause',
  requireRole('owner', 'manager'),
  requirePermission('manageMarketing'),
  validate({ params: idParamSchema }),
  MarketingController.pauseCampaign
);
marketingRouter.post(
  '/campaigns/:id/cancel',
  requireRole('owner', 'manager'),
  requirePermission('manageMarketing'),
  validate({ params: idParamSchema }),
  MarketingController.cancelCampaign
);

