const pino = require('pino');

/**
 * Logger estructurado único para todo el servicio. Reemplaza los
 * console.log/console.error sueltos: cada línea sale como JSON con
 * timestamp y nivel, lista para un agregador (ELK, Loki, CloudWatch, etc.)
 * en vez de texto libre para humanos. Ver DECISIONS.md, sección
 * "Observabilidad".
 *
 * `LOG_LEVEL` (default "info") permite subir a "debug" sin tocar código.
 * En desarrollo, `LOG_PRETTY=true` la imprime legible en vez de JSON crudo.
 */
const logger = pino({
  name: 'transaction-service',
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.LOG_PRETTY === 'true'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
});

module.exports = logger;
