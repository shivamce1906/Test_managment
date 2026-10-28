import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { PlatformAdmin, User, Business, Branch, IPlatformAdmin, IUser, EmailRegistry } from '../models';
import { getRedisClient } from '../integrations';
import { AppError, hashPassword, verifyPassword, generateRandomToken, logger } from '../utils';
import { RequestContext } from './context';
import { auditService } from './audit.service';
import { env } from '../config';

const JWT_SECRET = env.JWT_SECRET;
const JWT_ACCESS_TTL = env.JWT_ACCESS_TTL;

const REFRESH_TTLS = {
  superadmin: 12 * 60 * 60, // 12 hours
  owner: 30 * 24 * 60 * 60, // 30 days
  manager: 30 * 24 * 60 * 60, // 30 days
  branch: 7 * 24 * 60 * 60, // 7 days
};

export interface TokenPayload {
  sub: string;
  kind: 'platform' | 'tenant';
  role: 'superadmin' | 'owner' | 'manager' | 'branch';
  businessId?: string;
  sv: number;
}

export class AuthService {
  private redis = getRedisClient();

  /**
   * Generates a signed JWT access token.
   */
  generateAccessToken(payload: TokenPayload): string {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_ACCESS_TTL as any });
  }

  /**
   * Verifies an access token and checks sessionVersion against cached version.
   */
  async verifyAccessToken(token: string): Promise<TokenPayload> {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload;

      // Check session version in Redis (or DB fallback)
      const cachedSv = await this.redis.get(`sv:${decoded.sub}`);
      let sv: number | null = cachedSv !== null ? parseInt(cachedSv, 10) : null;
      if (sv === null) {
        if (decoded.kind === 'platform') {
          const admin = await PlatformAdmin.findById(decoded.sub);
          if (admin) {
            sv = admin.sessionVersion;
            await this.redis.set(`sv:${admin._id}`, sv.toString());
          }
        } else {
          const user = await User.findById(decoded.sub, null, { skipTenantScope: true });
          if (user) {
            sv = user.sessionVersion;
            await this.redis.set(`sv:${user._id}`, sv.toString());
          }
        }
      }

      if (sv !== null && sv !== decoded.sv) {
        throw new AppError(401, 'SESSION_REVOKED', 'Session has been revoked');
      }

      return decoded;
    } catch (err: any) {
      if (err instanceof AppError || err.name === 'AppError' || err.statusCode) throw err;
      throw new AppError(401, 'UNAUTHENTICATED', err.message || 'Invalid access token');
    }
  }

  /**
   * Issues and stores a new refresh token in Redis.
   */
  async issueRefreshToken(userId: string, role: 'superadmin' | 'owner' | 'manager' | 'branch'): Promise<string> {
    const tokenId = generateRandomToken(16);
    const secret = generateRandomToken(32);
    const refreshTokenString = `${userId}.${tokenId}.${secret}`;

    const ttl = REFRESH_TTLS[role];
    const key = `rt:${userId}:${tokenId}`;
    const hash = await hashPassword(secret);

    await this.redis.set(key, hash, 'EX', ttl);
    return refreshTokenString;
  }

  /**
   * Rotates a refresh token.
   */
  async rotateRefreshToken(refreshTokenString: string): Promise<{ accessToken: string; refreshToken: string; newRefreshToken: string }> {
    const parts = refreshTokenString.split('.');
    if (parts.length !== 3) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid refresh token format');
    }

    const [userId, tokenId, secret] = parts;
    const key = `rt:${userId}:${tokenId}`;
    const usedKey = `rt_used:${userId}:${tokenId}`;
    const storedHash = await this.redis.get(key);

    if (!storedHash) {
      const wasUsed = await this.redis.get(usedKey);
      if (wasUsed) {
        // Token reuse attack: revoke all user sessions
        await this.revokeAllSessions(userId);
        throw new AppError(401, 'SESSION_REVOKED', 'Refresh token reused, all sessions revoked');
      }
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired refresh token');
    }

    const isValid = await verifyPassword(secret, storedHash);
    if (!isValid) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid refresh token secret');
    }

    // Delete used token and mark as used for 300 seconds (rotation)
    await this.redis.del(key);
    await this.redis.set(usedKey, '1', 'EX', 300);

    // Look up user
    let user = await User.findById(userId, null, { skipTenantScope: true });
    let admin: IPlatformAdmin | null = null;
    let payload: TokenPayload;
    let role: 'superadmin' | 'owner' | 'manager' | 'branch';

    if (user) {
      if (user.status !== 'active') {
        throw new AppError(403, 'ACCOUNT_INACTIVE', 'Account is inactive');
      }
      const business = await Business.findById(user.businessId);
      if (!business || business.status !== 'active') {
        throw new AppError(403, 'BUSINESS_SUSPENDED', 'Business is suspended');
      }
      if (user.role === 'branch' && user.branchLoginFor) {
        const branch = await Branch.findOne({ _id: user.branchLoginFor, businessId: user.businessId });
        if (!branch || branch.status !== 'active') {
          throw new AppError(422, 'BRANCH_INACTIVE', 'Branch is inactive');
        }
      }
      role = user.role;
      payload = {
        sub: user._id.toString(),
        kind: 'tenant',
        role: user.role,
        businessId: user.businessId.toString(),
        sv: user.sessionVersion,
      };
    } else {
      admin = await PlatformAdmin.findById(userId);
      if (!admin || admin.status !== 'active') {
        throw new AppError(403, 'ACCOUNT_INACTIVE', 'Admin account is inactive');
      }
      role = 'superadmin';
      payload = {
        sub: admin._id.toString(),
        kind: 'platform',
        role: 'superadmin',
        sv: admin.sessionVersion,
      };
    }

    const accessToken = this.generateAccessToken(payload);
    const newRefreshToken = await this.issueRefreshToken(userId, role);

    return { accessToken, refreshToken: newRefreshToken, newRefreshToken };
  }

  /**
   * Logs out a session by deleting the refresh token.
   */
  async logout(refreshTokenString?: string): Promise<void> {
    if (!refreshTokenString) return;
    const parts = refreshTokenString.split('.');
    if (parts.length === 3) {
      const [userId, tokenId] = parts;
      await this.redis.del(`rt:${userId}:${tokenId}`);
    }
  }

  /**
   * Revokes all active refresh tokens for a user.
   */
  async revokeAllSessions(userId: string): Promise<void> {
    // Increment sessionVersion on DB
    const user = await User.findById(userId, null, { skipTenantScope: true });
    if (user) {
      user.sessionVersion += 1;
      await user.save();
      await this.redis.set(`sv:${userId}`, user.sessionVersion.toString());
    } else {
      const admin = await PlatformAdmin.findById(userId);
      if (admin) {
        admin.sessionVersion += 1;
        await admin.save();
        await this.redis.set(`sv:${userId}`, admin.sessionVersion.toString());
      }
    }

    // Delete all refresh token keys in Redis
    const keys = await this.redis.keys(`rt:${userId}:*`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  /**
   * Authenticates user with email and password.
   */
  async login(
    email: string,
    password: string
  ): Promise<{ accessToken: string; refreshToken: string; user: any }> {
    const normalisedEmail = email.trim().toLowerCase();

    // 1. Check PlatformAdmin first
    let admin = await PlatformAdmin.findOne({ email: normalisedEmail });
    if (admin) {
      // Check account lockout
      if (admin.lockedUntil && admin.lockedUntil > new Date()) {
        throw new AppError(403, 'ACCOUNT_LOCKED', 'Account is locked due to 5 failed logins', {
          details: { until: admin.lockedUntil },
        });
      }

      const isMatch = await verifyPassword(password, admin.passwordHash);
      if (!isMatch) {
        admin.failedLogins += 1;
        if (admin.failedLogins >= 5) {
          admin.lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 min lock
        }
        await admin.save();
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      }

      if (admin.status !== 'active') {
        throw new AppError(403, 'ACCOUNT_INACTIVE', 'Account is inactive');
      }

      // Reset lockout
      admin.failedLogins = 0;
      admin.lockedUntil = undefined;
      admin.lastLoginAt = new Date();
      await admin.save();

      await this.redis.set(`sv:${admin._id}`, admin.sessionVersion.toString());

      const payload: TokenPayload = {
        sub: admin._id.toString(),
        kind: 'platform',
        role: 'superadmin',
        sv: admin.sessionVersion,
      };

      const accessToken = this.generateAccessToken(payload);
      const refreshToken = await this.issueRefreshToken(admin._id.toString(), 'superadmin');

      return {
        accessToken,
        refreshToken,
        user: {
          id: admin._id.toString(),
          name: admin.name,
          email: admin.email,
          role: 'superadmin',
          kind: 'platform',
        },
      };
    }

    // 2. Check salon user
    const user = await User.findOne({ email: normalisedEmail }, null, { skipTenantScope: true });
    if (!user) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // Check account lockout
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(403, 'ACCOUNT_LOCKED', 'Account is locked due to 5 failed logins', {
        details: { until: user.lockedUntil },
      });
    }

    const isMatch = await verifyPassword(password, user.passwordHash);
    if (!isMatch) {
      user.failedLogins += 1;
      if (user.failedLogins >= 5) {
        user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 min lock
      }
      await user.save();
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    if (user.status !== 'active') {
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'User account is inactive');
    }

    // Check business status
    const business = await Business.findById(user.businessId);
    if (!business || business.status === 'suspended') {
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'Business account is suspended or inactive');
    }

    // Check branch status for branch logins
    if (user.role === 'branch') {
      const branch = await Branch.findById(user.branchLoginFor, null, { skipTenantScope: true });
      if (!branch || branch.status === 'deactivated') {
        throw new AppError(403, 'ACCOUNT_INACTIVE', 'Branch is deactivated');
      }
    }

    // Reset lockout
    user.failedLogins = 0;
    user.lockedUntil = undefined;
    user.lastLoginAt = new Date();
    await user.save();

    await this.redis.set(`sv:${user._id}`, user.sessionVersion.toString());

    const payload: TokenPayload = {
      sub: user._id.toString(),
      kind: 'tenant',
      role: user.role,
      businessId: user.businessId.toString(),
      sv: user.sessionVersion,
    };

    const accessToken = this.generateAccessToken(payload);
    const refreshToken = await this.issueRefreshToken(user._id.toString(), user.role);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        kind: 'tenant',
        businessId: user.businessId.toString(),
        branchIds: user.branchIds.map((b) => b.toString()),
        flags: user.flags,
      },
    };
  }

  /**
   * Sets new password for a user and revokes their sessions (no self-service).
   */
  async setPassword(ctx: RequestContext, targetUserId: string, newPassword: string): Promise<void> {
    const passwordHash = await hashPassword(newPassword);

    if (ctx.role === 'superadmin' || ctx.role === 'super_admin') {
      // Super admin can reset any password
      const user = await User.findById(targetUserId, null, { skipTenantScope: true });
      if (user) {
        user.passwordHash = passwordHash;
        user.sessionVersion += 1;
        await user.save();
        await this.revokeAllSessions(targetUserId);
        await auditService.logAction({
          ctx,
          action: 'user.password_set',
          entity: 'user',
          entityId: user._id,
          reason: 'Password reset by superadmin',
        });
        return;
      }

      const admin = await PlatformAdmin.findById(targetUserId);
      if (admin) {
        admin.passwordHash = passwordHash;
        admin.sessionVersion += 1;
        await admin.save();
        await this.revokeAllSessions(targetUserId);
        return;
      }
      throw new AppError(404, 'NOT_FOUND', 'Target user not found');
    }

    if (ctx.role === 'owner') {
      // Owner can set password for manager or branch login in own business
      const user = await User.findOne({
        _id: new Types.ObjectId(targetUserId),
        businessId: new Types.ObjectId(ctx.businessId!),
      });

      if (!user) {
        throw new AppError(404, 'NOT_FOUND', 'Target user not found');
      }

      if (user.role === 'owner') {
        throw new AppError(403, 'FORBIDDEN', 'Owner cannot set own password through this endpoint');
      }

      user.passwordHash = passwordHash;
      user.sessionVersion += 1;
      await user.save();
      await this.revokeAllSessions(targetUserId);

      await auditService.logAction({
        ctx,
        action: 'user.password_set',
        entity: 'user',
        entityId: user._id,
        reason: 'Password set by business owner',
      });
      return;
    }

    throw new AppError(403, 'FORBIDDEN', 'Permission denied to set user password');
  }
}

export const authService = new AuthService();
