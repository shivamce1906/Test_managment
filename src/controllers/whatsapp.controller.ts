import { Request, Response, NextFunction } from 'express';
import {
  getConversations,
  getConversationById,
  getMessages,
  sendMessage,
  syncWaTemplates,
  getWaNumbers,
  getWaTemplates,
  createCampaign,
  getCampaigns,
  getAutomations,
  updateAutomation,
  submitFeedback,
  processInboundWebhook,
  markChatRead,
  saveChatNote,
  findWaNumberForWebhook,
  webhookSecretMatches,
} from '../services';
import { AppError, ErrorCode } from '../utils';

export class WhatsappController {
  public static async processWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const identifier = req.params.uid || req.params.numberId;
      const waNum = await findWaNumberForWebhook(identifier);
      // Unknown numbers get a quick 200 so the provider stops retrying; nothing is stored
      if (!waNum) {
        res.json({ success: true });
        return;
      }
      const provided =
        (typeof req.query.secret === 'string' ? req.query.secret : undefined) ||
        ((req.headers['x-webhook-secret'] || req.headers['x-instantbroadcast-signature'] || req.headers['x-aisensy-signature']) as string | undefined);
      if (!webhookSecretMatches(waNum, provided)) {
        res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature' } });
        return;
      }
      await processInboundWebhook(waNum._id, req.body);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }

  public static async markChatRead(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await markChatRead(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async saveChatNote(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await saveChatNote(req.ctx, req.params.id, req.body.note);
      res.status(201).json(result);
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
      const branchId = req.query.branchId as string | undefined;
      const result = await getConversations(req.ctx, branchId || undefined, {
        unreadOnly: req.query.unreadOnly === 'true',
        search: typeof req.query.search === 'string' && req.query.search.trim() ? req.query.search : undefined,
      });
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
      const limit = Number(req.query.limit) || 50;
      const skip = Math.max(0, Number(req.query.skip) || 0);
      const result = await getMessages(req.ctx, conversationId, limit, skip);
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
      let numberId =
        (req.params.numberId as string) ||
        (req.body?.numberId as string) ||
        (req.query.numberId as string);
      if (!numberId) {
        const numbers = await getWaNumbers(req.ctx);
        const activeNum = numbers.find((n: any) => n.status === 'active') || numbers[0];
        if (!activeNum) {
          throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'No WhatsApp number configured for this business');
        }
        numberId = activeNum._id.toString();
      }
      const result = await syncWaTemplates(req.ctx, numberId);
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
