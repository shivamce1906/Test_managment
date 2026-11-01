import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { env } from '../config';
import { logger } from '../utils';

let io: SocketIOServer | null = null;

export interface AuthenticatedSocket extends Socket {
  user?: {
    userId: string;
    businessId: string;
    branchId?: string;
    role: string;
  };
}

export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.APP_ORIGINS || '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    path: '/socket.io',
    transports: ['websocket', 'polling'],
  });

  // Socket authentication middleware
  io.use((socket: AuthenticatedSocket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '') ||
        (socket.handshake.query?.token as string);

      if (!token) {
        return next(new Error('Authentication token required'));
      }

      const decoded = jwt.verify(token, env.JWT_SECRET) as any;
      socket.user = {
        userId: decoded.sub || decoded.userId,
        businessId: decoded.businessId,
        branchId: decoded.branchId,
        role: decoded.role,
      };

      return next();
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Unauthorized WebSocket connection attempt');
      return next(new Error('Invalid authentication token'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    if (!socket.user?.businessId) {
      socket.disconnect(true);
      return;
    }

    const { businessId, branchId, userId } = socket.user;
    logger.info({ userId, businessId, socketId: socket.id }, 'Management Dashboard client connected to WebSocket');

    // Join business tenant room
    socket.join(`business:${businessId}`);

    // Join branch room if branchId is present
    if (branchId) {
      socket.join(`branch:${branchId}`);
    }

    socket.on('disconnect', () => {
      logger.debug({ userId, socketId: socket.id }, 'Management Dashboard client disconnected');
    });
  });

  logger.info('Real-Time WebSocket gateway for Management System initialized');
  return io;
}

export function getSocketServer(): SocketIOServer | null {
  return io;
}

export function emitToBusiness(businessId: string, event: string, payload: any): void {
  if (!io) return;
  io.to(`business:${businessId}`).emit(event, payload);
}

export function emitToBranch(branchId: string, event: string, payload: any): void {
  if (!io) return;
  io.to(`branch:${branchId}`).emit(event, payload);
}

