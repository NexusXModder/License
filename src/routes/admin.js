'use strict';

const express = require('express');
const { z } = require('zod');
const { ApiError, asyncHandler, validate, dbFail } = require('../lib/http');
const { generateLicenseKey, normalizeLicenseKey, generateAppSecret } = require('../lib/crypto');

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const deviceParams = z.object({ id: uuid, deviceId: uuid });

const metadataSchema = z
  .record(z.string().min(1).max(40), z.union(z.string().max(500), [z.number().finite(), z.boolean(), z.null()]))
  .refine((m) => Object.keys(m).length <= 20, { message: 'At most 20 metadata keys' });

const reasonBody = z.object({ reason: z.string().trim().max(300).optional() }).strict();

const paging = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

const appFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  defaultDurationDays: z.number().int().min(1).max(3650).optional(),
  defaultMaxDevices: z.number().int().min(1).max(100).optional(),
  maxDevicesCap: z.number().int().min(1).max(100).optional(),
  maxDurationDays: z.number().int().min(1).max(36500).optional(),
  allowLifetime: z.boolean().optional(),
  metadata: metadataSchema.optional(),
};
const appCreateSchema = z.object(appFields).strict();
const appPatchSchema = z
  .object({ ...appFields, name: appFields.name.optional() })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Nothing to update' });

const licenseCreateSchema = z
  .object({
    appId: uuid,
    label: z.string().trim().min(1).max(120),
    durationDays: z.number().int().min(1).max(36500).optional(),
    lifetime: z.boolean().optional(),
    maxDevices: z.number().int().min(1).max(100).optional(),
    metadata: metadataSchema.optional(),
  })
  .strict();

const licensePatchSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    maxDevices: z.number().int().min(1).max(100).optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Nothing to update' });

const licenseListQuery = z.object({
  ...paging,
  search: z.string().max(100).optional(),
  status: z.enum(['active', 'suspended', 'revoked', 'expired']).optional(),
  appId: uuid.optional(),
});

const appListQuery = z.object({
  search: z.string().max(80).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

const auditListQuery = z.object({
  ...paging,
  type: z.string().regex(/^[a-z_.]{1,64}$/).optional(),
  targetId: uuid.optional(),
  actorId: uuid.optional(),
});

const sessionBody = z.object({ event: z.enum(['login', 'restore', 'logout']).default('restore') }).strict();

// ---------------------------------------------------------------------------
// Columns (hashes are NEVER selected for responses)
// ---------------------------------------------------------------------------
const LICENSE_COLS =
  'id, app_id, key_hint, label, status, status_reason, status_changed_at, max_devices, expires_at, metadata, ' +
  'created_at, updated_at, last_activated_at, last_verified_at, client_apps(name, client_id)';
const APP_COLS =
  'id, client_id, name, description, status, default_duration_days, default_max_devices, max_devices_cap, ' +
  'max_duration_days, allow_lifetime, secret_hash, secret_rotated_at, metadata, created_at, updated_at';
const DEVICE_COLS = 'id, label, status, created_at, last_seen_at, removed_at, removed_reason';
const AUDIT_COLS = 'id, event_type, actor_type, actor_id, target_type, target_id, request_id, metadata, created_at';

// ---------------------------------------------------------------------------
// Mappers & helpers
// ---------------------------------------------------------------------------
function toLicense(row, devicesUsed) {
  const expired =
    row.status === 'active' && row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now();
  return {
    id: row.id,
    appId: row.app_id,
    app: row.client_apps ? { name: row.client_apps.name, clientId: row.client_apps.client_id } : null,
    keyHint: row.key_hint,
    label: row.label,
    status: row.status,
    effectiveStatus: expired ? 'expired' : row.status,
    statusReason: row.status_reason,
    statusChangedAt: row.status_changed_at,
    maxDevices: row.max_devices,
    devicesUsed: typeof devicesUsed === 'number' ? devicesUsed : null,
    expiresAt: row.expires_at,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivatedAt: row.last_activated_at,
    lastVerifiedAt: row.last_verified_at,
  };
}

function toApp(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    description: row.description,
    status: row.status,
    defaultDurationDays: row.default_duration_days,
    defaultMaxDevices: row.default_max_devices,
    maxDevicesCap: row.max_devices_cap,
    maxDurationDays: row.max_duration_days,
    allowLifetime: row.allow_lifetime,
    hasSecret: Boolean(row.secret_hash),
    secretRotatedAt: row.secret_rotated_at,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDevice(row) {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    removedAt: row.removed_at,
    removedReason: row.removed_reason,
  };
}

function toAuditEvent(row) {
  return {
    id: row.id,
    type: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    targetType: row.target_type,
    targetId: row.target_id,
    requestId: row.request_id,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

function appInputToRow(body) {
  const map = {
    name: 'name',
    description: 'description',
    defaultDurationDays: 'default_duration_days',
    defaultMaxDevices: 'default_max_devices',
    maxDevicesCap: 'max_devices_cap',
    maxDurationDays: 'max_duration_days',
    allowLifetime: 'allow_lifetime',
    metadata: 'metadata',
  };
  const row = {};
  for (const [key, column] of Object.entries(map)) {
    if (body[key] !== undefined) row[column] = body[key];
  }
  return row;
}

/** Safe ILIKE fragment: strips odd characters and escapes wildcards. */
function cleanSearch(value) {
  if (!value) return '';
  return value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} @._-]/gu, '')
    .trim()
    .slice(0, 80)
    .replace(/[\\%_]/g, (c) => `\\${c}`);
}

const isRangeError = (error) => Boolean(error && error.code === 'PGRST103');

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function createAdminRouter({ db, keys, audit }) {
  const r = express.Router();

  r.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const adminEvent = (req, type, targetType, targetId, metadata) =>
    audit(req, { type, actorType: 'admin', actorId: req.admin.userId, targetType, targetId, metadata });

  async function loadApp(id, cols = APP_COLS) {
    const { data, error } = await db.from('client_apps').select(cols).eq('id', id).maybeSingle();
    if (error) throw dbFail(error);
    if (!data) throw new ApiError(404, 'not_found', 'Application not found');
    return data;
  }

  async function loadLicense(id, cols = LICENSE_COLS) {
    const { data, error } = await db.from('licenses').select(cols).eq('id', id).maybeSingle();
    if (error) throw dbFail(error);
    if (!data) throw new ApiError(404, 'not_found', 'License not found');
    return data;
  }

  async function countActiveDevices(licenseIds) {
    const counts = {};
    for (const id of licenseIds) counts[id] = 0;
    if (!licenseIds.length) return counts;
    const { data, error } = await db
      .from('devices')
      .select('license_id')
      .in('license_id', licenseIds)
      .eq('status', 'active');
    if (error) throw dbFail(error);
    for (const d of data) counts[d.license_id] = (counts[d.license_id] || 0) + 1;
    return counts;
  }

  // ------------------------------- Session --------------------------------
  r.post(
    '/session',
    asyncHandler(async (req, res) => {
      const { event } = validate(sessionBody, req.body);
      if (event === 'login') await adminEvent(req, 'admin.login', 'admin', req.admin.userId);
      if (event === 'logout') await adminEvent(req, 'admin.logout', 'admin', req.admin.userId);
      res.json({ ok: true, data: { userId: req.admin.userId, email: req.admin.email, role: req.admin.role } });
    })
  );

  r.get(
    '/stats',
    asyncHandler(async (req, res) => {
      const { data, error } = await db.rpc('nexus_admin_stats');
      if (error) throw dbFail(error);
      const s = (Array.isArray(data) ? data[0] : data) || {};
      res.json({
        ok: true,
        data: {
          total: Number(s.r_total || 0),
          active: Number(s.r_active || 0),
          suspended: Number(s.r_suspended || 0),
          revoked: Number(s.r_revoked || 0),
          expired: Number(s.r_expired || 0),
          activeDevices: Number(s.r_active_devices || 0),
          apps: Number(s.r_apps || 0),
        },
      });
    })
  );

  // ------------------------------- Apps -----------------------------------
  r.get(
    '/apps',
    asyncHandler(async (req, res) => {
      const q = validate(appListQuery, req.query);
      let query = db.from('client_apps').select(APP_COLS).order('created_at', { ascending: false }).limit(200);
      if (q.status) query = query.eq('status', q.status);
      const s = cleanSearch(q.search);
      if (s) query = query.ilike('name', `%${s}%`);
      const { data, error } = await query;
      if (error) throw dbFail(error);
      res.json({ ok: true, data: { items: data.map(toApp) } });
    })
  );

  r.post(
    '/apps',
    asyncHandler(async (req, res) => {
      const body = validate(appCreateSchema, req.body);
      const defMax = body.defaultMaxDevices ?? 1;
      const cap = body.maxDevicesCap ?? 10;
      const defDays = body.defaultDurationDays ?? 30;
      const maxDays = body.maxDurationDays ?? 3650;
      if (defMax > cap) throw new ApiError(400, 'invalid_policy', 'Default max devices cannot exceed the device cap');
      if (defDays > maxDays) throw new ApiError(400, 'invalid_policy', 'Default duration cannot exceed the maximum duration');

      const { data, error } = await db.from('client_apps').insert(appInputToRow(body)).select(APP_COLS).single();
      if (error) throw dbFail(error);
      await adminEvent(req, 'app.created', 'app', data.id, { name: data.name });
      res.status(201).json({ ok: true, data: { app: toApp(data) } });
    })
  );

  r.get(
    '/apps/:id',
    asyncHandler(async (req, res) => {
      const { id } = validate(idParam, req.params);
      const app = await loadApp(id);
      const [all, active] = await Promise.all(
        db.from('licenses').select('id', { count: 'exact', head: true }).eq('app_id', id),
        [db.from('licenses').select('id', { count: 'exact', head: true }).eq('app_id', id).eq('status', 'active'),
      ]);
      if (all.error) throw dbFail(all.error);
      if (active.error) throw dbFail(active.error);
      res.json({
        ok: true,
        data: { app: toApp(app), licenseCount: all.count || 0, activeLicenseCount: active.count || 0 },
      });
    })
  );

  r.patch(
    '/apps/:id',
    asyncHandler(async (req, res) => {
      const { id } = validate(idParam, req.params);
      const body = validate(appPatchSchema, req.body);
      const { data, error } = await db
        .from('client_apps')
        .update(appInputToRow(body))
        .eq('id', id)
        .select(APP_COLS)
        .maybeSingle();
      if (error) throw dbFail(error);
      if (!data) throw new ApiError(404, 'not_found', 'Application not found');
      await adminEvent(req, 'app.updated', 'app', id, { fields: Object.keys(body).join(',') });
      res.json({ ok: true, data: { app: toApp(data) } });
    })
  );

  async function setAppStatus(req, res, to) {
    const { id } = validate(idParam, req.params);
    const { data, error } = await db
      .from('client_apps')
      .update({ status: to })
      .eq('id', id)
      .select(APP_COLS)
      .maybeSingle();
    if (error) throw dbFail(error);
    if (!data) throw new ApiError(404, 'not_found', 'Application not found');
    await adminEvent(req, to === 'active' ? 'app.enabled' : 'app.disabled', 'app', id);
    res.json({ ok: true, data: { app: toApp(data) } });
  }

  r.post('/apps/:id/disable', asyncHandler((req, res) => setAppStatus(req, res, 'disabled')));
  r.post('/apps/:id/enable', asyncHandler((req, res) => setAppStatus(req, res, 'active')));

  // Generate / rotate app secret (shown ONCE, stored only as HMAC)
  r.post(
    '/apps/:id/secret',
    asyncHandler(async (req, res) => {
      const { id } = validate(idParam, req.params);
      const appSecret = generateAppSecret();
      const { data, error } = await db
        .from('client_apps')
        .update({ secret_hash: keys.hashAppSecret(appSecret), secret_rotated_at: new Date().toISOString() })
        .eq('id', id)
        .select(APP_COLS)
        .maybeSingle();
      if (error) throw dbFail(error);
      if (!data) throw new ApiError(404, 'not_found', 'Application not found');
      await adminEvent(req, 'app.secret_rotated', 'app', id);
      res.json({ ok: true, data: { app: toApp(data), appSecret } });
    })
  );

  r.delete(
    '/apps/:id/secret',
    asyncHandler(async (req, res) => {
      const { id } = validate(idParam, req.params);
      const { data, error } = await db
        .from('client_apps')
        .update({ secret_hash: null, secret_rotated_at: new Date().toISOString() })
        .eq('id', id)
        .select(APP_COLS)
        .maybeSingle();
      if (error) throw dbFail(error);
      if (!data) throw new ApiError(404, 'not_found', 'Application not found');
      await adminEvent(req, 'app.secret_removed', 'app', id);
      res.json({ ok: true, data: { app: toApp(data) } });
    })
  );

  // ------------------------------- Licenses -------------------------------
  r.get(
    '/licenses',
    asyncHandler(async (req, res) => {
      const q = validate(licenseListQuery, req.query);
      const from = (q.page - 1) * q.pageSize;
      const nowIso = new Date().toISOString();

      let query = db
        .from('licenses')
        .select(LICENSE_COLS, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, from + q.pageSize - 1);

      if (q.appId) query = query.eq('app_id', q.appId);
      if (q.status === 'expired') query = query.eq('status', 'active').lte('expires_at', nowIso);
      else if (q.status === 'active') {
        query = query.eq('status', 'active').or(`expires_at.is.null,expires_at.gt."${nowIso}"`);
      } else if (q.status) query = query.eq('status', q.status);

      if (q.search) {
        const normalized = normalizeLicenseKey(q.search);
        if (normalized) {
          query = query.eq('key_hash', keys.hashLicenseKey(normalized)); // admin pasted a full key
        } else {
          const s = cleanSearch(q.search);
          if (s) query = query.ilike('label', `%${s}%`);
        }
      }

      const { data, error, count } = await query;
      if (isRangeError(error)) {
        return res.json({ ok: true, data: { items: [], page: q.page, pageSize: q.pageSize, total: 0 } });
      }
      if (error) throw dbFail(error);

      const counts = await countActiveDevices(data.map((l) => l.id));
      return res.json({
        ok: true,
        data: {
          items: data.map((l) => toLicense(l, counts[l.id])),
          page: q.page,
          pageSize: q.pageSize,
          total: count || 0,
        },
      });
    })
  );

  r.post(
    '/licenses',
    asyncHandler(async (req, res) => {
      const body = validate(licenseCreateSchema, req.body);
      const app = await loadApp(body.appId);
      if (app.status !== 'active') throw new ApiError(409, 'app_disabled', 'This application is disabled');

      const maxDevices = body.maxDevices ?? app.default_max_devices;
      if (maxDevices > app.max_devices_cap) {
        throw new ApiError(400, 'limit_exceeded', `This application allows at most ${app.max_devices_cap} devices`);
      }

      let expiresAt = null;
      if (body.lifetime) {
        if (!app.allow_lifetime) {
          throw new ApiError(400, 'lifetime_not_allowed', 'Lifetime licenses are disabled for this application');
        }
      } else {
        const days = body.durationDays ?? app.default_duration_days;
        if (days > app.max_duration_days) {
          throw new ApiError(400, 'limit_exceeded', `Maximum duration for this application is ${app.max_duration_days} days`);
        }
        expiresAt = new Date(Date.now() + days * DAY_MS).toISOString();
      }

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const licenseKey = generateLicenseKey();
        const normalized = normalizeLicenseKey(licenseKey);
        const { data, error } = await db
          .from('licenses')
          .insert({
            app_id: app.id,
            key_hash: keys.hashLicenseKey(normalized),
            key_hint: normalized.slice(-4),
            label: body.label,
            max_devices: maxDevices,
            expires_at: expiresAt,
            metadata: body.metadata || {},
            created_by: req.admin.userId,
          })
          .select(LICENSE_COLS)
          .single();

        if (error && error.code === '23505' && attempt < 3) continue; // astronomically rare collision
        if (error) throw dbFail(error);

        await adminEvent(req, 'license.created', 'license', data.id, {
          appId: app.id,
          maxDevices,
          expiresAt,
          lifetime: expiresAt === null,
        });

        // The plaintext key exists ONLY in this response. It is not stored anywhere.
        return res.status(201).json({ ok: true, data: { license: toLicense(data, 0), licenseKey } });
      }
      throw new ApiError(500, 'generation_failed', 'Could not generate a unique license key');
    })
  );

  r.get(
    '/licenses/:id',
    asyncHandler(async (req, res) => {
      const { id } = validate(idParam, req.params);
      const license = await loadLicense(id);
      const { data: devices, error } = await db
        .from('devices')
        .select(DEVICE_COLS)
        .eq('license_id', id)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw dbFail(error);
      const counts = await countActiveDevices([id]);
      res.json({ ok: true, data: { license: toLicense(license, counts[id]), devices: devices.map(toDevice) } });
    })
  );

  r.patch(
    '/licenses/:id',
    asyncHandler(async (req, res) => {
      const { id } = validate(idParam, req.params);
      const body = validate(licensePatchSchema, req.body);
      const current = await loadLicense(id, 'id, status, client_apps(max_devices_cap, max_duration_days, allow_lifetime)');
      if (current.status === 'revoked') throw new ApiError(409, 'license_revoked', 'Revoked licenses cannot be edited');

      const policy = current.client_apps;
      const update = {};
      if (body.label !== undefined) update.label = body.label;
      if (body.metadata !== undefined) update.metadata = body.metadata;
      if (body.maxDevices !== undefined) {
        if (body.maxDevices > policy.max_devices_cap) {
          throw new ApiError(400, 'limit_exceeded', `This application allows at most ${policy.max_devices_cap} devices`);
        }
        update.max_devices = body.maxDevices;
      }
      if (body.expiresAt !== undefined) {
        if (body.expiresAt === null) {
          if (!policy.allow_lifetime) {
            throw new ApiError(400, 'lifetime_not_allowed', 'Lifetime licenses are disabled for this application');
          }
          update.expires_at = null;
        } else {
          const t = Date.parse(body.expiresAt);
          if (t <= Date.now()) throw new ApiError(400, 'invalid_expiry', 'Expiry must be in the future');
          if (t > Date.now() + policy.max_duration_days * DAY_MS) {
            throw new ApiError(400, 'invalid_expiry', `Expiry exceeds the ${policy.max_duration_days}-day maximum`);
          }
          update.expires_at = new Date(t).toISOString();
        }
      }

      const { data, error } = await db
        .from('licenses')
        .update(update)
        .eq('id', id)
        .neq('status', 'revoked')
        .select(LICENSE_COLS)
        .maybeSingle();
      if (error) throw dbFail(error);
      if (!data) throw new ApiError(409, 'license_revoked', 'License state changed, please reload');

      await adminEvent(req, 'license.updated', 'license', id, { fields: Object.keys(body).join(',') });
      const counts = await countActiveDevices([id]);
      res.json({ ok: true, data: { license: toLicense(data, counts[id]) } });
    })
  );

  /** Atomic conditional status transition (UPDATE ... WHERE status IN (...)). */
  async function transition(req, res, { from, to, event }) {
    const { id } = validate(idParam, req.params);
    const { reason } = validate(reasonBody, req.body);

    const { data, error } = await db
      .from('licenses')
      .update({ status: to, status_reason: reason || null })
      .eq('id', id)
      .in('status', from)
      .select(LICENSE_COLS)
      .maybeSingle();
    if (error) throw dbFail(error);

    if (!data) {
      const existing = await db.from('licenses').select('status').eq('id', id).maybeSingle();
      if (existing.error) throw dbFail(existing.error);
      if (!existing.data) throw new ApiError(404, 'not_found', 'License not found');
      throw new ApiError(409, 'invalid_transition', `License is already ${existing.data.status}`);
    }

    await adminEvent(req, event, 'license', id, { reason: reason || null });
    const counts = await countActiveDevices([id]);
    res.json({ ok: true, data: { license: toLicense(data, counts[id]) } });
  }

  r.post('/licenses/:id/suspend', asyncHandler((req, res) =>
    transition(req, res, { from: ['active'], to: 'suspended', event: 'license.suspended' })));
  r.post('/licenses/:id/reactivate', asyncHandler((req, res) =>
    transition(req, res, { from: ['suspended'], to: 'active', event: 'license.reactivated' })));
  r.post('/licenses/:id/revoke', asyncHandler((req, res) =>
    transition(req, res, { from: ['active', 'suspended'], to: 'revoked', event: 'license.revoked' })));

  // ------------------------------- Devices --------------------------------
  r.get(
    '/licenses/:id/devices',
    asyncHandler(async (req, res) => {
      const { id } = validate(idParam, req.params);
      await loadLicense(id, 'id');
      const { data, error } = await db
        .from('devices')
        .select(DEVICE_COLS)
        .eq('license_id', id)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw dbFail(error);
      res.json({ ok: true, data: { items: data.map(toDevice) } });
    })
  );

  r.delete(
    '/licenses/:id/devices/:deviceId',
    asyncHandler(async (req, res) => {
      const { id, deviceId } = validate(deviceParams, req.params);
      const { data, error } = await db
        .from('devices')
        .update({ status: 'removed', removed_at: new Date().toISOString(), removed_reason: 'admin' })
        .eq('id', deviceId)
        .eq('license_id', id)
        .eq('status', 'active')
        .select(DEVICE_COLS)
        .maybeSingle();
      if (error) throw dbFail(error);
      if (!data) throw new ApiError(404, 'not_found', 'Active device not found');
      await adminEvent(req, 'device.removed', 'device', deviceId, { licenseId: id });
      res.json({ ok: true, data: { device: toDevice(data) } });
    })
  );

  r.post(
    '/licenses/:id/devices/reset',
    asyncHandler(async (req, res) => {
      const { id } = validate(idParam, req.params);
      await loadLicense(id, 'id');
      const { data, error } = await db
        .from('devices')
        .update({ status: 'removed', removed_at: new Date().toISOString(), removed_reason: 'license_reset' })
        .eq('license_id', id)
        .eq('status', 'active')
        .select('id');
      if (error) throw dbFail(error);
      await adminEvent(req, 'device.reset', 'license', id, { removed: data.length });
      res.json({ ok: true, data: { removed: data.length } });
    })
  );

  // ------------------------------- Audit ----------------------------------
  r.get(
    '/audit-events',
    asyncHandler(async (req, res) => {
      const q = validate(auditListQuery, req.query);
      const from = (q.page - 1) * q.pageSize;
      let query = db
        .from('audit_events')
        .select(AUDIT_COLS, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, from + q.pageSize - 1);
      if (q.type) query = query.ilike('event_type', `${q.type.replace(/_/g, '\\_')}%`);
      if (q.targetId) query = query.eq('target_id', q.targetId);
      if (q.actorId) query = query.eq('actor_id', q.actorId);

      const { data, error, count } = await query;
      if (isRangeError(error)) {
        return res.json({ ok: true, data: { items: [], page: q.page, pageSize: q.pageSize, total: 0 } });
      }
      if (error) throw dbFail(error);
      return res.json({
        ok: true,
        data: { items: data.map(toAuditEvent), page: q.page, pageSize: q.pageSize, total: count || 0 },
      });
    })
  );

  return r;
}

module.exports = { createAdminRouter };