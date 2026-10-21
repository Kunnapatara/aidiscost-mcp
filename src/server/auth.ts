/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { ServerStorage, getStorage } from './storage';
import { User } from './types';

// Cookie configuration
export const SESSION_COOKIE_NAME = 'aidiscost_session';
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function getSessionCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_DURATION_MS,
  };
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  try {
    const [salt, originalHash] = storedHash.split(':');
    if (!salt || !originalHash) return false;
    const computedHash = crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex');
    const a = Buffer.from(originalHash, 'hex');
    const b = Buffer.from(computedHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export interface AuthenticatedRequest extends Request {
  user?: User;
  sessionToken?: string;
  rawBody?: Buffer;
}

/**
 * Authentication Middleware:
 * Inspects session cookie or Bearer token, validates against ServerStorage, and attaches req.user.
 */
export async function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    let token: string | undefined = req.cookies?.[SESSION_COOKIE_NAME];

    if (!token && req.headers.authorization) {
      const parts = req.headers.authorization.split(' ');
      if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        token = parts[1];
      }
    }

    if (token) {
      const storage = getStorage();
      const sessionData = await storage.getSession(token);
      if (sessionData) {
        req.user = sessionData.user;
        req.sessionToken = token;
      }
    }
  } catch (err) {
    console.warn('[Auth] Error resolving session:', (err as Error).message);
  }
  next();
}

/**
 * Route guard requiring an authenticated user.
 */
export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Authentication required. Please sign in or create an account.',
    });
    return;
  }
  next();
}
