'use strict';

const { createClient } = require('@supabase/supabase-js');
const { config } = require('./config');
const { createKeyring } = require('./lib/crypto');
const { createAudit } = require('./lib/audit');
const { createTokenVerifier } = require('./middleware/auth');

function buildDeps({ secrets, logger }) {
  const db = createClient(config.supabaseUrl, secrets.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const keys = createKeyring(secrets.pepper);
  const audit = createAudit({ db, keys, logger });
  const verifyAccessToken = createTokenVerifier({ supabaseUrl: config.supabaseUrl, db });
  return { db, keys, audit, logger, verifyAccessToken };
}

module.exports = { buildDeps };