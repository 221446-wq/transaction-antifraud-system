const express = require('express');
const pool = require('../db/pool');
const metrics = require('../metrics');
const repo = require('../repository/referenceRatesRepository');
const { SOURCE_NAME } = require('../collector');
const logger = require('../logger');

const app = express();

// Express 5 reenvía automáticamente el rechazo de una promesa devuelta por
// un handler al middleware de error (última función abajo) — no hace falta
// un wrapper tipo asyncHandler como en transaction-service (ahí se agregó
// antes de esta versión de Express, se mantuvo por consistencia con el
// código existente; acá, al ser un servicio nuevo, no había motivo para
// repetirlo).

app.get('/health/live', (req, res) => {
  res.json({ status: 'ok', service: 'reference-data-service' });
});

app.get('/health/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', checks: { postgres: 'ok' } });
  } catch (err) {
    res.status(503).json({ status: 'degraded', checks: { postgres: 'error' }, error: err.message });
  }
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metrics.register.contentType);
  res.end(await metrics.register.metrics());
});

// Único endpoint de negocio del servicio: consulta de solo lectura de las
// tasas recolectadas. No participa del flujo de transacciones/antifraude —
// ver docs/WEB_SCRAPING.md.
app.get('/reference-rates', async (req, res) => {
  const rates = await repo.latestRates();
  res.json({ baseCurrency: 'EUR', rates });
});

app.get('/reference-rates/:currency', async (req, res) => {
  const rates = await repo.latestRates(req.params.currency);
  if (rates.length === 0) {
    return res.status(404).json({
      errors: [{ field: 'currency', message: `No hay tasas guardadas para ${req.params.currency.toUpperCase()}.` }],
    });
  }
  return res.json({ baseCurrency: 'EUR', rate: rates[0] });
});

// Endpoint operativo (no de negocio): expone el checkpoint crudo de la
// fuente — etag, último fingerprint, fallos consecutivos — útil para
// diagnosticar sin tener que conectarse directo a Postgres.
app.get('/reference-rates-source-status', async (req, res) => {
  const status = await repo.getSourceStatus(SOURCE_NAME);
  res.json(status || { message: 'La fuente todavía no corrió ninguna recolección.' });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  logger.error({ error: err.message }, 'Error no manejado en el servidor HTTP');
  res.status(500).json({ errors: [{ field: null, message: 'Error interno del servidor.' }] });
});

function start(port) {
  return app.listen(port, () => {
    logger.info({ port }, 'reference-data-service: servidor HTTP escuchando');
  });
}

module.exports = { app, start };
