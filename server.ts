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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function createServerApp() {
  const app = express();
  const isProd = process.env.NODE_ENV === 'production';

  // In production, validate persistent database configuration on boot (fail-closed)
  if (isProd) {
    const { getStorage } = await import('./src/server/storage');
    getStorage();
  }

  // Raw body capture for webhook signature verification
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
if (process.env.NODE_ENV !== 'test') {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  createServerApp().then((app) => {
    app.listen(port, '0.0.0.0', () => {
      console.log(`[AIDisCost] Server running on http://0.0.0.0:${port}`);
    });
  });
}
