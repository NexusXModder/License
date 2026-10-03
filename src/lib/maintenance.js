'use strict';

const { ApiError, dbFail } = require('./http');

const DEFAULT_MESSAGE = 'System is under maintenance. Please try again later.';

async function getMaintenance(db) {
  const { data, error } = await db
    .from('system_settings')
    .select('maintenance_mode, maintenance_message')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw dbFail(error);

  return {
    enabled: Boolean(data && data.maintenance_mode),
    message: String((data && data.maintenance_message) || DEFAULT_MESSAGE).slice(0, 500),
  };
}

function createMaintenanceMiddleware(db) {
  return async (req, res, next) => {
    try {
      const state = await getMaintenance(db);
      if (!state.enabled) return next();

      return res.status(503).json({
        ok: false,
        error: {
          code: 'maintenance',
          message: state.message,
        },
        requestId: req.id,
      });
    } catch (err) {
      return next(err);
    }
  };
}

async function setMaintenance(db, enabled, message) {
  const cleanMessage = String(message || '').trim().slice(0, 500) || DEFAULT_MESSAGE;
  const { data, error } = await db
    .from('system_settings')
    .upsert(
      {
        id: 1,
        maintenance_mode: Boolean(enabled),
        maintenance_message: cleanMessage,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    )
    .select('maintenance_mode, maintenance_message, updated_at')
    .single();

  if (error) throw dbFail(error);
  return {
    enabled: Boolean(data.maintenance_mode),
    message: data.maintenance_message,
    updatedAt: data.updated_at,
  };
}

module.exports = {
  DEFAULT_MESSAGE,
  getMaintenance,
  setMaintenance,
  createMaintenanceMiddleware,
};
