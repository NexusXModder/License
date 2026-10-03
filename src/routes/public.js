'use strict';

const express = require('express');
const { z } = require('zod');
const { ApiError, asyncHandler, validate, dbFail } = require('../lib/http');
const { normalizeLicenseKey, generateDeviceToken, isDeviceTokenFormat } = require('../lib/crypto');

const clientIdSchema = z.string().regex(/^app_[a-z0-9]{8,40}$/, 'Invalid clientId');

const activateSchema = z
  .object({
    clientId: clientIdSchema,
    licenseKey: z.string().min(10).max(64),
    fingerprint: z.string().min(8).max(256).optional(),
    deviceLabel: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const tokenSchema = z
  .object({
    clientId: clientIdSchema,
    deviceToken: z.string().min(10).max(128),
  })
  .strict();

const FAILURES = {
  invalid: [403, 'license_invalid', 'License key is not valid for this application'],
  suspended: [403, 'license_suspended', 'This license is suspended'],
  revoked: [403, 'license_revoked', 'This license has been revoked'],
  expired: [403, 'license_expired', 'This license has expired'],
  device_limit: [409, 'device_limit_reached', 'Maximum number of devices reached for this license'],
  device_removed: [403, 'device_removed', 'This device has been deactivated'],
};

function fail(result, details) {
  const f = FAILURES[result] || FAILURES.invalid;
  return new ApiError(f[0], f[1], f[2], details);
}

function firstRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function createPublicRouter({ db, keys, audit, limits, config }) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  /** Client app must exist, be active, and present its secret if one is configured. */
  async function authenticateClient(req, clientId) {
    const { data, error } = await db
      .from('client_apps')
      .select('id, status, secret_hash')
      .eq('client_id', clientId)
      .maybeSingle();
    if (error) throw dbFail(error);

    const provided = req.get('x-nexus-app-secret');
    const ok =
      data &&
      data.status === 'active' &&
      (!data.secret_hash || keys.verifyAppSecret(provided, data.secret_hash));

    if (!ok) {
      let reason = 'bad_secret';
      if (!data) reason = 'unknown_client';
      else if (data.status !== 'active') reason = 'app_disabled';
      await audit(req, {
        type: 'client.auth_failed',
        actorType: 'anonymous',
        targetType: data ? 'app' : null,
        targetId: data ? data.id : null,
        metadata: { reason },
      });
      throw new ApiError(401, 'invalid_client', 'Unknown or unauthorized application');
    }
    return data;
  }

  // POST /api/v1/licenses/activate
  router.post(
    '/activate',
    limits.activate,
    asyncHandler(async (req, res) => {
      const body = validate(activateSchema, req.body);
      const app = await authenticateClient(req, body.clientId);

      const normalized = normalizeLicenseKey(body.licenseKey);
      if (!normalized) {
        await audit(req, {
          type: 'license.activation_failed',
          actorType: 'client',
          targetType: 'app',
          targetId: app.id,
          metadata: { reason: 'malformed' },
        });
        throw fail('invalid');
      }

      const deviceToken = generateDeviceToken();
      const { data, error } = await db.rpc('nexus_activate_device', {
        p_client_id: body.clientId,
        p_key_hash: keys.hashLicenseKey(normalized),
        p_token_hash: keys.hashDeviceToken(deviceToken),
        p_fingerprint_hash: body.fingerprint ? keys.hashFingerprint(body.clientId, body.fingerprint) : null,
        p_label: body.deviceLabel || null,
      });
      if (error) throw dbFail(error);

      const row = firstRow(data);
      if (!row || row.r_result !== 'ok') {
        const reason = row ? row.r_result : 'invalid';
        await audit(req, {
          type: 'license.activation_failed',
          actorType: 'client',
          targetType: row && row.r_license_id ? 'license' : 'app',
          targetId: (row && row.r_license_id) || app.id,
          metadata: { reason },
        });
        throw fail(reason, reason === 'device_limit' ? { maxDevices: row.r_max_devices } : undefined);
      }

      await audit(req, {
        type: 'device.activated',
        actorType: 'client',
        targetType: 'license',
        targetId: row.r_license_id,
        metadata: { deviceId: row.r_device_id, devicesUsed: row.r_devices_used },
      });

      res.json({
        ok: true,
        data: {
          deviceToken,
          expiresAt: row.r_expires_at,
          devicesUsed: row.r_devices_used,
          maxDevices: row.r_max_devices,
          revalidateAfterSeconds: config.revalidateAfterSeconds,
        },
      });
    })
  );

  // POST /api/v1/licenses/verify
  router.post(
    '/verify',
    limits.verify,
    asyncHandler(async (req, res) => {
      const body = validate(tokenSchema, req.body);
      await authenticateClient(req, body.clientId);
      if (!isDeviceTokenFormat(body.deviceToken)) throw fail('invalid');

      const { data, error } = await db.rpc('nexus_verify_device', {
        p_client_id: body.clientId,
        p_token_hash: keys.hashDeviceToken(body.deviceToken),
      });
      if (error) throw dbFail(error);

      const row = firstRow(data);
      if (!row || row.r_result !== 'ok') {
        const reason = row ? row.r_result : 'invalid';
        await audit(req, {
          type: 'license.verify_failed',
          actorType: 'client',
          targetType: row && row.r_license_id ? 'license' : null,
          targetId: (row && row.r_license_id) || null,
          metadata: { reason },
        });
        throw fail(reason);
      }

      res.json({
        ok: true,
        data: { valid: true, expiresAt: row.r_expires_at, revalidateAfterSeconds: config.revalidateAfterSeconds },
      });
    })
  );

  // POST /api/v1/licenses/deactivate
  router.post(
    '/deactivate',
    limits.deactivate,
    asyncHandler(async (req, res) => {
      const body = validate(tokenSchema, req.body);
      await authenticateClient(req, body.clientId);
      if (!isDeviceTokenFormat(body.deviceToken)) {
        throw new ApiError(404, 'device_not_found', 'Device not found or already deactivated');
      }

      const { data, error } = await db.rpc('nexus_deactivate_device', {
        p_client_id: body.clientId,
        p_token_hash: keys.hashDeviceToken(body.deviceToken),
      });
      if (error) throw dbFail(error);

      const row = firstRow(data);
      if (!row || row.r_result !== 'ok') {
        throw new ApiError(404, 'device_not_found', 'Device not found or already deactivated');
      }

      await audit(req, {
        type: 'device.deactivated',
        actorType: 'client',
        targetType: 'license',
        targetId: row.r_license_id,
        metadata: { deviceId: row.r_device_id },
      });

      res.json({ ok: true, data: { deactivated: true } });
    })
  );

  return router;
}

module.exports = { createPublicRouter };