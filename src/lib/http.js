'use strict';

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

function validate(schema, input) {
  const result = schema.safeParse(input === undefined ? {} : input);
  if (!result.success) {
    const details = result.error.issues.slice(0, 10).map((i) => ({
      field: i.path.join('.') || '(body)',
      message: i.message,
    }));
    throw new ApiError(400, 'validation_error', 'Request validation failed', details);
  }
  return result.data;
}

/** Map a Supabase/PostgREST error to a safe ApiError (never leaks internals). */
function dbFail(error) {
  const code = error && error.code;
  if (code === '23505') return new ApiError(409, 'conflict', 'A record with these values already exists');
  if (['23514', '23502', '22P02', '22007', '22008', '23503'].includes(code)) {
    return new ApiError(400, 'invalid_input', 'Value rejected by database rules');
  }
  if (code === 'P0001') {
    return new ApiError(409, 'rule_violation', String(error.message || 'Operation not allowed').slice(0, 200));
  }
  const err = new ApiError(503, 'database_error', 'Database request failed');
  err.cause = error;
  return err;
}

function createErrorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let apiErr = err instanceof ApiError ? err : null;
    if (!apiErr && err) {
      if (err.type === 'entity.too.large') apiErr = new ApiError(413, 'payload_too_large', 'Request body too large');
      else if (err.type === 'entity.parse.failed') apiErr = new ApiError(400, 'invalid_json', 'Malformed JSON body');
      else if (typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
        apiErr = new ApiError(err.status, 'bad_request', 'Bad request');
      }
    }

    if (!apiErr || apiErr.status >= 500) {
      logger.error('request_failed', {
        requestId: req.id,
        path: req.originalUrl ? req.originalUrl.split('?')[0] : undefined,
        errorCode: err && err.code,
        errorMessage: err && err.message,
        causeCode: err && err.cause && err.cause.code,
        causeMessage: err && err.cause && err.cause.message,
      });
    }

    if (res.headersSent) return;
    const status = apiErr ? apiErr.status : 500;
    const body = {
      ok: false,
      error: {
        code: apiErr ? apiErr.code : 'internal_error',
        message: apiErr ? apiErr.message : 'Internal server error',
      },
      requestId: req.id,
    };
    if (apiErr && apiErr.details !== undefined) body.error.details = apiErr.details;
    res.status(status).json(body);
  };
}

module.exports = { ApiError, asyncHandler, validate, dbFail, createErrorHandler };