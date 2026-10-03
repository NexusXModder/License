'use strict';

/**
 * Central configuration.
 * PUBLIC values below are safe to commit (they are not secrets).
 * SECRETS are read only from environment variables (Render -> Environment).
 */
const PUBLIC_SUPABASE = Object.freeze({
  url: 'https://kjuhcodypwoymrmedtki.supabase.co',
  publishableKey: 'sb_publishable_Ja01iQLK_A8ik3b0SKrXfA_91EHL5yU',
});

const env = process.env.NODE_ENV || (process.env.RENDER ? 'production' : 'development');

function intFromEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

const config = Object.freeze({
  env,
  isProduction: env === 'production',
  isTest: env === 'test',
  port: intFromEnv('PORT', 3000, 1, 65535),
  trustProxyHops: intFromEnv('TRUST_PROXY_HOPS', 1, 0, 10),
  supabaseUrl: PUBLIC_SUPABASE.url,
  supabasePublishableKey: PUBLIC_SUPABASE.publishableKey,
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  revalidateAfterSeconds: 300,
});

function readServerSecrets() {
  const secretKey = (process.env.SUPABASE_SECRET_KEY || '').trim();
  const pepper = (process.env.LICENSE_KEY_PEPPER || '').trim();
  const problems = [];

  if (!secretKey) problems.push('SUPABASE_SECRET_KEY is not set');
  else if (secretKey.startsWith('sb_publishable_')) {
    problems.push('SUPABASE_SECRET_KEY contains the publishable key; use the secret key (sb_secret_...)');
  }
  if (pepper.length < 32) problems.push('LICENSE_KEY_PEPPER must be at least 32 characters');

  if (problems.length) {
    const err = new Error(
      `Server secrets missing or invalid:\n - ${problems.join('\n - ')}\n` +
        'Set them in Render -> your service -> Environment.'
    );
    err.code = 'CONFIG_ERROR';
    throw err;
  }
  return { secretKey, pepper };
}

module.exports = { config, readServerSecrets };