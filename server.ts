/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticate } from './src/server/auth';
import { createApiRouter } from './src/server/api';
import { createMcpRouter } from './src/server/mcp/router';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runProductionStartupPreflight(): Promise<void> {
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  if (!tursoUrl) {
    throw new Error(
      '[FATAL PRODUCTION CONFIGURATION ERROR] In production (NODE_ENV=production), TURSO_DATABASE_URL is required. ' +
      'Silent fallback to local in-memory or filesystem database is strictly prohibited.'
    );
  }

  if (
    (tursoUrl.startsWith('libsql://') || tursoUrl.startsWith('https://')) &&
    !process.env.TURSO_AUTH_TOKEN
  ) {
    throw new Error(
      '[FATAL PRODUCTION CONFIGURATION ERROR] In production with a remote Turso database, TURSO_AUTH_TOKEN is required.'
    );
  }

  const { getStorage } = await import('./src/server/storage');
  const storage = getStorage();

  const isReady = typeof storage.checkReadiness === 'function'
    ? await storage.checkReadiness()
    : false;

  if (!isReady) {
    throw new Error(
      '[FATAL PRODUCTION STARTUP ERROR] Database preflight check failed. The database is either unreachable or missing required migration tables. Run "npm run db:migrate" before starting the server.'
    );
  }
}

export async function createServerApp() {
  const app = express();
  const isProd = process.env.NODE_ENV === 'production';

  // In production, validate persistent database configuration and schema on boot (fail-closed)
  if (isProd) {
    await runProductionStartupPreflight();
  }

  // Scoped MCP endpoint: 2MB body limit, cookie parsing, and authentication
  app.use(
    '/mcp',
    express.json({
      limit: '2mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
    cookieParser(),
    authenticate,
    createMcpRouter()
  );

  // Raw body capture for webhook signature verification on standard API routes
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Global authentication resolver
  app.use(authenticate);

  // Mount API endpoints
  app.use('/api', createApiRouter());

  // Mount Frontend
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  return app;
}

// Start server if executed directly
const isDirectRun = Boolean(
  process.argv[1] &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'))
);
if (isDirectRun && process.env.NODE_ENV !== 'test') {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  createServerApp()
    .then((app) => {
      const server = app.listen(port, '0.0.0.0', () => {
        console.log(`[AIDisCost] Server running on http://0.0.0.0:${port}`);
      });

      // Graceful shutdown handling
      const shutdown = async (signal: string) => {
        console.log(`[AIDisCost] Received ${signal}. Draining connections and shutting down gracefully...`);
        server.close(async () => {
          try {
            const { getStorage } = await import('./src/server/storage');
            const storage = getStorage();
            if (typeof storage.close === 'function') {
              await storage.close();
            }
          } catch {
            // Ignore closing error
          }
          console.log('[AIDisCost] Shutdown complete.');
          process.exit(0);
        });

        // Force shutdown after timeout if connections fail to close
        setTimeout(() => {
          console.error('[AIDisCost] Forced shutdown after timeout.');
          process.exit(1);
        }, 10_000).unref();
      };

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((err) => {
      console.error('[AIDisCost] Fatal startup error:', err.message);
      process.exit(1);
    });
}
