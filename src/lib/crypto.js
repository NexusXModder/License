'use strict';

const crypto = require('node:crypto');

// Crockford Base32 (no I, L, O, U). 32 symbols -> no modulo bias with "& 31".
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_PREFIX = 'NX';
const KEY_BODY_LENGTH = 25; // 25 x 5 bits = 125 bits of entropy
const KEY_PATTERN = /^NX[0-9A-HJKMNP-TV-Z]{25}$/;
const DEVICE_TOKEN_PATTERN = /^ndt_[A-Za-z0-9_-]{43}$/;
const APP_SECRET_PATTERN = /^nas_[A-Za-z0-9_-]{43}$/;

function randomBase32(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] & 31];
  return out;
}

/** Returns a display key like NX-ABCDE-FGHJK-MNPQR-STVWX-YZ234 */
function generateLicenseKey() {
  const body = randomBase32(KEY_BODY_LENGTH);
  return `${KEY_PREFIX}-${body.match(/.{5}/g).join('-')}`;
}

/** Canonical form used for hashing. Returns null if the input is not a Nexus key. */
function normalizeLicenseKey(input) {
  if (typeof input !== 'string' || input.length > 64) return null;
  const compact = input.toUpperCase().replace(/[\s-]/g, '');
  if (!compact.startsWith(KEY_PREFIX)) return null;
  const body = compact.slice(KEY_PREFIX.length).replace(/O/g, '0').replace(/[IL]/g, '1');
  const normalized = KEY_PREFIX + body;
  return KEY_PATTERN.test(normalized) ? normalized : null;
}

function generateDeviceToken() {
  return `ndt_${crypto.randomBytes(32).toString('base64url')}`;
}

function generateAppSecret() {
  return `nas_${crypto.randomBytes(32).toString('base64url')}`;
}

function isDeviceTokenFormat(value) {
  return typeof value === 'string' && DEVICE_TOKEN_PATTERN.test(value);
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** All keyed hashes (HMAC-SHA256 with server-only pepper, domain-separated). */
function createKeyring(pepper) {
  if (typeof pepper !== 'string' || pepper.length < 32) {
    throw new Error('LICENSE_KEY_PEPPER must be at least 32 characters');
  }
  const mac = (purpose, value) =>
    crypto.createHmac('sha256', pepper).update(`nexus:${purpose}:${value}`).digest('hex');

  return Object.freeze({
    hashLicenseKey: (normalized) => mac('license', normalized),
    hashDeviceToken: (token) => mac('device', token),
    hashFingerprint: (clientId, fingerprint) => mac('fingerprint', `${clientId}:${fingerprint}`),
    hashAppSecret: (secret) => mac('app-secret', secret),
    verifyAppSecret: (secret, expectedHex) =>
      typeof secret === 'string' && APP_SECRET_PATTERN.test(secret) && safeEqualHex(mac('app-secret', secret), expectedHex),
    hashIp: (ip) => mac('ip', String(ip)).slice(0, 32),
  });
}

module.exports = {
  generateLicenseKey,
  normalizeLicenseKey,
  generateDeviceToken,
  generateAppSecret,
  isDeviceTokenFormat,
  createKeyring,
  safeEqualHex,
};