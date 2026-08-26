const pino = require('pino');

/**
 * Logger estructurado único del servicio — ver el equivalente en
 * transaction-service/src/logger.js y DECISIONS.md, "Observabilidad".
 */
const logger = pino({
  name: 'antifraud-service',
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.LOG_PRETTY === 'true'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
});

module.exports = logger;
