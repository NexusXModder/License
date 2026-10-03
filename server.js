'use strict';

const { config, readServerSecrets } = require('./src/config');
const { createLogger } = require('./src/lib/logger');

const logger = createLogger();

let secrets;
try {
  secrets = readServerSecrets();
} catch (err) {
  logger.error('startup_config_error', { message: err.message });
  process.exit(1);
}

const { buildDeps } = require('./src/deps');
const { createApp } = require('./src/app');

const app = createApp(buildDeps({ secrets, logger }));

const server = app.listen(config.port, () => {
  logger.info('server_started', { port: config.port, env: config.env });
});

function shutdown(signal) {
  logger.info('shutdown', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { message: reason && reason.message });
});