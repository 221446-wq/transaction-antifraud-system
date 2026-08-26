const pino = require('pino');

/**
 * Logger estructurado único del servicio — mismo criterio que en
 * transaction-service/src/logger.js y antifraud-service/src/logger.js: ver
 * DECISIONS.md, "Observabilidad".
 */
const logger = pino({
  name: 'reference-data-service',
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.LOG_PRETTY === 'true'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
});

module.exports = logger;
