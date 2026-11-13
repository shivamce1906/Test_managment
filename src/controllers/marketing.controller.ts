import { Request, Response, NextFunction } from 'express';
import {
  segmentationService,
  marketingOfferService,
  marketingCampaignService,
} from '../services';

export class MarketingController {
  // --------------------------------------------------
  // Customer Segments
  // --------------------------------------------------

  static async createSegment(req: Request, res: Response, next: NextFunction) {
    try {
      const segment = await segmentationService.createSegment(req.ctx!, req.body);
      res.status(201).json(segment);
    } catch (err) {
      next(err);
    }
  }

  static async getSegments(req: Request, res: Response, next: NextFunction) {
    try {
      const segments = await segmentationService.getSegments(req.ctx!);
      res.json(segments);
    } catch (err) {
      next(err);
    }
  }

  static async getSegmentById(req: Request, res: Response, next: NextFunction) {
    try {
      const segment = await segmentationService.getSegmentById(req.ctx!, req.params.id);
      res.json(segment);
    } catch (err) {
      next(err);
    }
  }

  static async updateSegment(req: Request, res: Response, next: NextFunction) {
    try {
      const segment = await segmentationService.updateSegment(req.ctx!, req.params.id, req.body);
      res.json(segment);
    } catch (err) {
      next(err);
    }
  }

  static async deleteSegment(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await segmentationService.deleteSegment(req.ctx!, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async previewSegment(req: Request, res: Response, next: NextFunction) {
    try {
      const preview = await segmentationService.previewSegment(req.ctx!, req.body.criteria);
      res.json(preview);
    } catch (err) {
      next(err);
    }
  }

  static async previewSegmentCustomers(req: Request, res: Response, next: NextFunction) {
    try {
      const { criteria, page, limit, q } = req.body;
      res.json(await segmentationService.previewSegmentCustomers(req.ctx!, criteria, { page, limit, q }));
    } catch (err) {
      next(err);
    }
  }

  static async getSegmentCustomers(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await segmentationService.getSegmentCustomers(req.ctx!, req.params.id, {
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 25,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  // --------------------------------------------------
  // Promotional Offers
  // --------------------------------------------------

  static async createOffer(req: Request, res: Response, next: NextFunction) {
    try {
      const offer = await marketingOfferService.createOffer(req.ctx!, req.body);
      res.status(201).json(offer);
    } catch (err) {
      next(err);
    }
  }

  static async getOffers(req: Request, res: Response, next: NextFunction) {
    try {
      const offers = await marketingOfferService.getOffers(req.ctx!, {
        activeOnly: req.query.activeOnly === 'true',
        type: req.query.type as string,
      });
      res.json(offers);
    } catch (err) {
      next(err);
    }
  }

  static async getOfferById(req: Request, res: Response, next: NextFunction) {
    try {
      const offer = await marketingOfferService.getOfferById(req.ctx!, req.params.id);
      res.json(offer);
    } catch (err) {
      next(err);
    }
  }

  static async updateOffer(req: Request, res: Response, next: NextFunction) {
    try {
      const offer = await marketingOfferService.updateOffer(req.ctx!, req.params.id, req.body);
      res.json(offer);
    } catch (err) {
      next(err);
    }
  }

  static async deleteOffer(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await marketingOfferService.deleteOffer(req.ctx!, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async validateOffer(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await marketingOfferService.validateOfferForCustomer(req.ctx!, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  // --------------------------------------------------
  // Campaigns
  // --------------------------------------------------

  static async createCampaign(req: Request, res: Response, next: NextFunction) {
    try {
      const campaign = await marketingCampaignService.createCampaign(req.ctx!, req.body);
      res.status(201).json(campaign);
    } catch (err) {
      next(err);
    }
  }

  static async getCampaigns(req: Request, res: Response, next: NextFunction) {
    try {
      const campaigns = await marketingCampaignService.getCampaigns(req.ctx!);
      res.json(campaigns);
    } catch (err) {
      next(err);
    }
  }

  static async getCampaignById(req: Request, res: Response, next: NextFunction) {
    try {
      const campaign = await marketingCampaignService.getCampaignById(req.ctx!, req.params.id);
      res.json(campaign);
    } catch (err) {
      next(err);
    }
  }

  static async updateCampaign(req: Request, res: Response, next: NextFunction) {
    try {
      const campaign = await marketingCampaignService.updateCampaign(req.ctx!, req.params.id, req.body);
      res.json(campaign);
    } catch (err) {
      next(err);
    }
  }

  static async scheduleCampaign(req: Request, res: Response, next: NextFunction) {
    try {
      const campaign = await marketingCampaignService.scheduleCampaign(
        req.ctx!,
        req.params.id,
        req.body.scheduledAt
      );
      res.json(campaign);
    } catch (err) {
      next(err);
    }
  }

  static async sendCampaignNow(req: Request, res: Response, next: NextFunction) {
    try {
      const campaign = await marketingCampaignService.sendCampaignNow(req.ctx!, req.params.id);
      res.json(campaign);
    } catch (err) {
      next(err);
    }
  }

  static async pauseCampaign(req: Request, res: Response, next: NextFunction) {
    try {
      const campaign = await marketingCampaignService.pauseCampaign(req.ctx!, req.params.id);
      res.json(campaign);
    } catch (err) {
      next(err);
    }
  }

  static async cancelCampaign(req: Request, res: Response, next: NextFunction) {
    try {
      const campaign = await marketingCampaignService.cancelCampaign(req.ctx!, req.params.id);
      res.json(campaign);
    } catch (err) {
      next(err);
    }
  }

  static async getCampaignAnalytics(req: Request, res: Response, next: NextFunction) {
    try {
      const analytics = await marketingCampaignService.getCampaignAnalytics(req.ctx!, req.params.id);
      res.json(analytics);
    } catch (err) {
      next(err);
    }
  }
}

