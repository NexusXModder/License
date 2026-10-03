'use strict';

const BLOCKED_META_KEY = /(key|token|secret|password)/i;

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(meta).slice(0, 20)) {
    if (BLOCKED_META_KEY.test(k)) continue;
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
  }
  return out;
}

/** Audit writes never break the main request; failures are logged. */
function createAudit({ db, keys, logger }) {
  return async function audit(req, event) {
    const row = {
      event_type: event.type,
      actor_type: event.actorType || 'system',
      actor_id: event.actorId || null,
      target_type: event.targetType || null,
      target_id: event.targetId || null,
      request_id: req && req.id ? String(req.id).slice(0, 64) : null,
      ip_hash: req && req.ip ? keys.hashIp(req.ip) : null,
      metadata: sanitizeMeta(event.metadata),
    };
    try {
      const { error } = await db.from('audit_events').insert(row);
      if (error) logger.warn('audit_insert_failed', { type: event.type, errorCode: error.code });
    } catch (err) {
      logger.warn('audit_insert_failed', { type: event.type, errorMessage: err.message });
    }
  };
}

module.exports = { createAudit, sanitizeMeta };