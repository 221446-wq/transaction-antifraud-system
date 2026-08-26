#!/usr/bin/env node
/**
 * Aplica src/db/schema.sql. A propósito no se usa Prisma Migrate acá (ver
 * pool.js): es un `CREATE TABLE IF NOT EXISTS` idempotente, suficiente para
 * el alcance de este servicio. Correr con `npm run migrate`.
 */
const fs = require('node:fs');
const path = require('node:path');
const pool = require('./pool');
const logger = require('../logger');

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  logger.info('reference-data-service: esquema aplicado (reference_rate_sources, reference_rates)');
  await pool.end();
}

migrate().catch((err) => {
  logger.error({ error: err.message }, 'No se pudo aplicar el esquema');
  process.exitCode = 1;
});
