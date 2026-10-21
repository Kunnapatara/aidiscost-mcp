/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, Request, Response, NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server';
import { AuthenticatedRequest } from '../auth';
import { IStorage } from '../storage-interface';

// Bounded in-memory rate-limiting safeguard for prototype (non-durable, per-process)
interface RateLimitEntry {
  count: number;
  resetAt: number;
}
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 60; // 60 requests per minute
const rateLimitMap = new Map<string, RateLimitEntry>();

// Periodic cleanup of stale rate-limit buckets every 5 minutes
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);
if (cleanupInterval.unref) {
  cleanupInterval.unref();
}

function mcpRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const clientKey = req.ip || req.socket.remoteAddress || 'unknown-client';
  const now = Date.now();
  let entry = rateLimitMap.get(clientKey);

  if (!entry || now > entry.resetAt) {
    entry = { count: 1, resetAt: now + WINDOW_MS };
    rateLimitMap.set(clientKey, entry);
    return next();
  }

  entry.count++;
  if (entry.count > MAX_REQUESTS_PER_WINDOW) {
    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please slow down and try again later.',
    });
    return;
  }

  next();
}

export function createMcpRouter(customStorage?: IStorage): Router {
  const router = Router();

  // Apply rate limiter to all MCP routes
  router.use(mcpRateLimiter);

  // POST /mcp - Main JSON-RPC Streamable HTTP endpoint
  router.post('/', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      // MCP protocol requires Accept header to include both application/json and text/event-stream.
      // If client sent application/json or omitted text/event-stream, normalize it to satisfy protocol check.
      const currentAccept = req.headers['accept'] || '';
      if (!currentAccept.includes('text/event-stream')) {
        req.headers['accept'] = currentAccept
          ? `${currentAccept}, text/event-stream`
          : 'application/json, text/event-stream';
      }

      // Create request-scoped McpServer bound to this request's authenticated user
      const mcpServer = createMcpServer(req.user, customStorage);

      // Create a fresh StreamableHTTPServerTransport for this request in stateless mode
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error while processing MCP request.',
          },
          id: req.body?.id ?? null,
        });
      }
    }
  });

  // Handle unsupported HTTP methods
  router.all('/', (_req: Request, res: Response): void => {
    res.status(405).json({
      error: 'METHOD_NOT_ALLOWED',
      message: 'MCP endpoint only accepts HTTP POST requests.',
    });
  });

  return router;
}
