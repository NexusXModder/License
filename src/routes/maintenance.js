'use strict';

const express = require('express');
const { z } = require('zod');
const { ApiError, asyncHandler, validate } = require('../lib/http');
const { getMaintenance, setMaintenance } = require('../lib/maintenance');

const updateSchema = z.object({
  enabled: z.boolean(),
  message: z.string().trim().max(500).optional(),
}).strict();

function createMaintenanceRouter({ db, audit }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json({ ok: true, data: await getMaintenance(db) });
    })
  );

  router.patch(
    '/',
    asyncHandler(async (req, res) => {
      const body = validate(updateSchema, req.body);
      const current = await getMaintenance(db);
      const next = await setMaintenance(db, body.enabled, body.message ?? current.message);

      await audit(req, {
        type: body.enabled ? 'system.maintenance_enabled' : 'system.maintenance_disabled',
        actorType: 'admin',
        actorId: req.admin.userId,
        targetType: 'system',
        targetId: null,
        metadata: {
          message: next.message,
        },
      });

      res.json({ ok: true, data: next });
    })
  );

  return router;
}

module.exports = { createMaintenanceRouter };
