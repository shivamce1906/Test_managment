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

import { Types } from 'mongoose';
import { WaNumber } from '../models';
import { AppError, ErrorCode, decryptData } from '../utils';
import { AiSensyAdapter } from '../integrations/aisensy/aisensy.adapter';

export class WhatsappController {
  public static async processWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const numberId = req.params.numberId;
      if (!numberId || !Types.ObjectId.isValid(numberId)) {
        res.status(200).json({ success: true });
        return;
      }

      const waNum = await WaNumber.findOne({ _id: numberId }, null, { skipTenantScope: true });
      if (!waNum) {
        res.status(200).json({ success: true });
        return;
      }

      const signature = req.headers['x-aisensy-signature'] as string | undefined;
      if (signature && waNum.aisensy?.webhookSecretEnc) {
        let secret = '';
        try {
          secret = decryptData(waNum.aisensy.webhookSecretEnc);
        } catch {
          secret = waNum.aisensy.webhookSecretEnc;
        }
        const adapter = new AiSensyAdapter();
        if (!adapter.verifyWebhookSignature(secret, signature, req.body)) {
          throw new AppError(403, ErrorCode.FORBIDDEN, 'Invalid webhook signature');
        }
      }

      await processInboundWebhook(numberId, req.body);
      res.status(200).json({ success: true });
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
