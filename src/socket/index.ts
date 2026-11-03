import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { env } from '../config';
import { logger } from '../utils';
import { AuthService } from '../services/auth.service';
import { User } from '../models';

const authService = new AuthService();

let io: SocketIOServer | null = null;

export interface AuthenticatedSocket extends Socket {
  user?: {
    userId: string;
    businessId: string;
    branchIds: string[];
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

  // Socket authentication: same checks as HTTP (signature, expiry, revoked session, active salon user)
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '') ||
        (socket.handshake.query?.token as string);

      if (!token) {
        return next(new Error('Authentication token required'));
      }

      const decoded = await authService.verifyAccessToken(token);
      if (decoded.kind !== 'tenant') return next(new Error('Salon users only'));
      const user = await User.findById(decoded.sub, null, { skipTenantScope: true });
      if (!user || user.status !== 'active') return next(new Error('User account is inactive or not found'));

      socket.user = {
        userId: user._id.toString(),
        businessId: user.businessId.toString(),
        branchIds: (user.branchIds || []).map((b) => b.toString()),
        role: user.role,
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

    const { businessId, branchIds, userId, role } = socket.user;
    logger.info({ userId, businessId, socketId: socket.id }, 'Management Dashboard client connected to WebSocket');

    // Owners hear every branch; managers and branch logins only their own branches
    if (role === 'owner') {
      socket.join(`owners:${businessId}`);
    } else {
      for (const b of branchIds) socket.join(`branch:${b}`);
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

/** Owners of the business only (events that span every branch, e.g. the provider's whole chat list). */
export function emitToOwners(businessId: string, event: string, payload: any): void {
  if (!io) return;
  io.to(`owners:${businessId}`).emit(event, payload);
}

/** The owners plus every manager and branch login of one branch (each socket gets it once). */
export function emitToBranch(businessId: string, branchId: string, event: string, payload: any): void {
  if (!io) return;
  io.to(`owners:${businessId}`).to(`branch:${branchId}`).emit(event, payload);
}

