const env = require('./config/env');
const logger = require('./logger');
const pool = require('./db/pool');
const scheduler = require('./scheduler');
const httpServer = require('./http/server');

logger.info({ sourceUrl: env.sourceUrl, pollIntervalMs: env.pollIntervalMs }, 'reference-data-service inicializado');

// El servidor HTTP (health/metrics/consulta) y el scheduler de recolección
// son independientes entre sí: si uno falla al arrancar, no debería tumbar
// al otro. Cada uno maneja sus propios errores internamente (ver
// http/server.js y scheduler.js).
const server = httpServer.start(env.port);
scheduler.start();

/**
 * Apagado ordenado: mismo patrón que transaction-service/src/index.js y
 * antifraud-service/src/index.js — deja de aceptar conexiones nuevas,
 * detiene el scheduler, cierra el pool de Postgres, y fuerza la salida a
 * los 10s si algo se cuelga. Ver DECISIONS.md, "Apagado ordenado".
 */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Señal recibida, iniciando apagado ordenado');

  const forceExitTimer = setTimeout(() => process.exit(1), 10_000);
  forceExitTimer.unref();

  scheduler.stop();
  server.close();
  await pool.end();

  clearTimeout(forceExitTimer);
  logger.info('Apagado ordenado completo');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
