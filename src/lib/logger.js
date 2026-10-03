'use strict';

const SENSITIVE_KEY = /(authorization|password|secret|token|cookie|pepper|licensekey|apikey)/i;

function redact(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : v;
  }
  return out;
}

function createLogger({ silent = false } = {}) {
  const write = (level, msg, meta) => {
    if (silent) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...redact(meta) });
    if (level === 'error') console.error(line);
    else console.log(line);
  };
  return {
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
  };
}

module.exports = { createLogger, redact };