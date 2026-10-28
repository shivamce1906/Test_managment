import { Request, Response, NextFunction } from 'express';
import {
  getConversations,
  getConversationById,
  getMessages,
  sendMessage,
  syncWaTemplates,
  getWaTemplates,
  createCampaign,
  getCampaigns,
  getAutomations,
  updateAutomation,
  submitFeedback,
  processInboundWebhook,
} from '../services';

export class WhatsappController {
  public static async processWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await processInboundWebhook(req.params.numberId, req.body);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }

  public static async submitFeedback(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await submitFeedback(req.ctx, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getConversations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const branchId = req.query.branchId as string;
      const status = req.query.status as any;
      const result = await getConversations(req.ctx, branchId, status);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getConversationById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getConversationById(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const conversationId = req.query.conversationId as string;
      if (!conversationId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'conversationId is required' } });
        return;
      }
      const result = await getMessages(req.ctx, conversationId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async sendMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const conversationId = (req.body.conversationId as string) || (req.query.conversationId as string);
      if (!conversationId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'conversationId is required' } });
        return;
      }
      const result = await sendMessage(req.ctx, conversationId, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getTemplates(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getWaTemplates(req.ctx);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async syncTemplates(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await syncWaTemplates(req.ctx, req.ctx.businessId!);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async createCampaign(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await createCampaign(req.ctx, req.body);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getCampaigns(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getCampaigns(req.ctx);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getAutomations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getAutomations(req.ctx);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async updateAutomation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await updateAutomation(req.ctx, req.params.key, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}
