'use strict';

const { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } = require('jose');
const { ApiError, asyncHandler, dbFail } = require('../lib/http');

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/**
 * Verifies Supabase access tokens.
 * - Asymmetric signing keys (ES256/RS256): verified locally via the project's JWKS
 *   (signature, expiry, issuer, audience; key rotation handled by JWKS refresh).
 * - Legacy symmetric (HS256) projects: verified server-side by Supabase Auth (getUser).
 * Decoded-but-unverified claims are never trusted.
 */
function createTokenVerifier({ supabaseUrl, db }) {
  const issuer = `${supabaseUrl}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    cooldownDuration: 30000,
    cacheMaxAge: 10 * 60 * 1000,
  });

  return async function verifyAccessToken(token) {
    let header;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new ApiError(401, 'invalid_token', 'Invalid session token');
    }

    if (header.alg === 'ES256' || header.alg === 'RS256') {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer,
          audience: 'authenticated',
          algorithms: ['ES256', 'RS256'],
        });
        if (typeof payload.sub !== 'string' || payload.role !== 'authenticated') {
          throw new ApiError(401, 'invalid_token', 'Invalid session token');
        }
        return { userId: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
      } catch (err) {
        if (err instanceof ApiError) throw err;
        if (err && err.code === 'ERR_JWT_EXPIRED') {
          throw new ApiError(401, 'token_expired', 'Session expired, please sign in again');
        }
        if (err && (err.code === 'ERR_JWKS_TIMEOUT' || err.name === 'TypeError')) {
          throw new ApiError(503, 'auth_unavailable', 'Authentication service unavailable');
        }
        throw new ApiError(401, 'invalid_token', 'Invalid session token');
      }
    }

    const { data, error } = await db.auth.getUser(token);
    if (error || !data || !data.user) {
      throw new ApiError(401, 'invalid_token', 'Invalid or expired session');
    }
    return { userId: data.user.id, email: data.user.email || null };
  };
}

/** Authentication + explicit server-side admin authorization (admin_users allowlist). */
function createRequireAdmin({ verifyAccessToken, db, audit }) {
  return asyncHandler(async (req, res, next) => {
    const match = BEARER.exec(req.get('authorization') || '');
    if (!match || match[1].length > 8192) {
      throw new ApiError(401, 'auth_required', 'Authentication required');
    }

    const identity = await verifyAccessToken(match[1]);

    const { data, error } = await db
      .from('admin_users')
      .select('role')
      .eq('user_id', identity.userId)
      .maybeSingle();
    if (error) throw dbFail(error);

    if (!data) {
      await audit(req, {
        type: 'admin.authz_denied',
        actorType: 'anonymous',
        actorId: identity.userId,
        metadata: { path: String(req.path).slice(0, 100) },
      });
      throw new ApiError(403, 'forbidden', 'This account is not an administrator');
    }

    req.admin = { userId: identity.userId, email: identity.email, role: data.role };
    next();
  });
}

module.exports = { createTokenVerifier, createRequireAdmin };