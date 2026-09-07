import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import apiRoutes from './routes';
import { errorHandler } from './middleware/errorHandler';

export function createApp() {
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '32kb' }));

  /**
   * The demo dashboard is a single ~78 KB file at the repo root. It is served
   * from there directly — there is deliberately no copy under backend/public and
   * no sync step, because a second copy is the only way this file can go stale
   * (ALL_IS_FIXED #5). If the root file is absent (e.g. a backend-only deploy),
   * the handler falls through to the express.static mount below — so a
   * backend/public/demo.html copy still works — and otherwise to a normal 404.
   */
  const demoDashboardPath = path.resolve(__dirname, '..', '..', 'demo_dashboard.html');
  app.get('/demo.html', (_req, res, next) => {
    res.sendFile(demoDashboardPath, { headers: { 'Cache-Control': 'no-store' } }, (err) => {
      // missing file → fall through to express.static, then Express's default 404;
      // client abort mid-send → headers already committed, just drop it.
      if (err && !res.headersSent) next();
    });
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', apiRoutes);

  app.use(errorHandler);

  return app;
}
