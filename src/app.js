'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const { config } = require('./config');
const { createErrorHandler } = require('./lib/http');
const { createRequireAdmin } = require('./middleware/auth');
const { createRateLimits } = require('./middleware/rateLimits');
const { createPublicRouter } = require('./routes/public');
const { createAdminRouter } = require('./routes/admin');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SUPABASE_UMD = path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');

function publicCors(allowed) {
  return (req, res, next) => {
    const origin = req.get('origin');
    const permitted = Boolean(origin && allowed.includes(origin));
    if (permitted) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      res.vary('Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(permitted ? 204 : 403);
    return next();
  };
}

function createApp(deps) {
  const { db, keys, audit, logger, verifyAccessToken } = deps;
  const limits = deps.limits || createRateLimits();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);

  // Request ID + access log (no query strings, bodies or headers are logged)
  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/healthz') return;
      logger.info('http', {
        requestId: req.id,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - started) / 1000000n),
      });
    });
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'https://fonts.gstatic.com'],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'", config.supabaseUrl],
          'frame-ancestors': ["'none'"],
          'form-action': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'upgrade-insecure-requests': config.isProduction ? [] : null,
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginEmbedderPolicy: false,
    })
  );

  // Health checks (Render health check path: /healthz)
  app.get('/healthz', (req, res) => res.json({ ok: true, status: 'up' }));
  app.get('/readyz', async (req, res) => {
    try {
      const { error } = await db.from('client_apps').select('id', { count: 'exact', head: true }).limit(1);
      if (error) throw error;
      res.json({ ok: true, database: 'up' });
    } catch {
      res.status(503).json({ ok: false, database: 'down' });
    }
  });

  // Public (non-secret) config for the dashboard: single source of truth
  app.get('/api/v1/public-config', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      ok: true,
      data: { supabaseUrl: config.supabaseUrl, supabasePublishableKey: config.supabasePublishableKey },
    });
  });

  // Old v1 endpoints are permanently removed
  app.all(['/api/admin-login', '/api/generate', '/api/keys', '/api/key/:id', '/api/verify'], (req, res) => {
    res.status(410).json({
      ok: false,
      error: { code: 'endpoint_removed', message: 'This legacy endpoint was removed. Use /api/v1.' },
      requestId: req.id,
    });
  });

  app.use(
    '/api/v1/licenses',
    publicCors(config.corsOrigins),
    express.json({ limit: '4kb' }),
    createPublicRouter({ db, keys, audit, limits, config })
  );

  app.use(
    '/api/v1/admin',
    limits.admin,
    express.json({ limit: '16kb' }),
    createRequireAdmin({ verifyAccessToken, db, audit }),
    createAdminRouter({ db, keys, audit })
  );

  app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, error: { code: 'not_found', message: 'Endpoint not found' }, requestId: req.id });
  });

  // Self-hosted Supabase browser client (no third-party script CDN)
  app.get('/vendor/supabase.js', (req, res, next) => {
    if (!fs.existsSync(SUPABASE_UMD)) return next();
    res.set('Cache-Control', 'public, max-age=86400');
    return res.sendFile(SUPABASE_UMD);
  });

  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
      },
    })
  );

  app.use(createErrorHandler(logger));
  return app;
}

module.exports = { createApp };