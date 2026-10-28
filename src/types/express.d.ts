import { RequestContext } from '../services';
import { Logger } from 'pino';

declare global {
  namespace Express {
    interface Request {
      ctx: RequestContext;
      log: Logger;
      id: string;
    }
  }
}
