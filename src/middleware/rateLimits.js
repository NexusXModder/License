'use strict';

const { rateLimit } = require('express-rate-limit');

function tooMany(req, res) {
  res.status(429).json({
    ok: false,
    error: { code: 'rate_limited', message: 'Too many requests, please slow down' },
    requestId: req.id,
  });
}

function clientKey(req) {
  const cid = req.body && typeof req.body.clientId === 'string' ? req.body.clientId.slice(0, 64) : '-';
  return `${req.ip}|${cid}`;
}

function createRateLimits({ disabled = false, overrides = {} } = {}) {
  const base = { standardHeaders: 'draft-7', legacyHeaders: false, handler: tooMany, skip: () => disabled };
  return {
    // Only FAILED activations count -> brute-force resistance without blocking real users
    activate: rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 30, skipSuccessfulRequests: true, keyGenerator: clientKey, ...overrides.activate }),
    verify: rateLimit({ ...base, windowMs: 60 * 1000, limit: 600, keyGenerator: clientKey, ...overrides.verify }),
    deactivate: rateLimit({ ...base, windowMs: 60 * 1000, limit: 60, keyGenerator: clientKey, ...overrides.deactivate }),
    admin: rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 600, ...overrides.admin }),
  };
}

module.exports = { createRateLimits };