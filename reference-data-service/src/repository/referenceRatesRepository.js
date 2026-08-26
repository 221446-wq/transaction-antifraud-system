const crypto = require('node:crypto');
const pool = require('../db/pool');

/**
 * `reference_rate_sources` es tanto el catálogo de fuentes como su
 * checkpoint (etag, fingerprint, fallos consecutivos) — ver
 * src/db/schema.sql. La primera vez que corre `collectOnce` para una
 * fuente nueva, esta función la crea con el checkpoint vacío.
 */
async function getOrCreateSource(name, url) {
  const existing = await pool.query('SELECT * FROM reference_rate_sources WHERE name = $1', [name]);
  if (existing.rows.length > 0) {
    return existing.rows[0];
  }
  const inserted = await pool.query(
    'INSERT INTO reference_rate_sources (name, url) VALUES ($1, $2) RETURNING *',
    [name, url],
  );
  return inserted.rows[0];
}

/**
 * Huella de deduplicación: no del HTML crudo (cambia por cosas irrelevantes
 * — banners, espacios, orden de atributos) sino de los datos ya extraídos
 * y normalizados. Si dos corridas dan el mismo fingerprint, es la misma
 * información aunque el bombeo de bytes HTML haya sido distinto.
 */
function computeFingerprint({ baseCurrency, rateDate, rates }) {
  const sortedRates = [...rates]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map(({ currency, rate }) => `${currency}:${rate}`);
  const canonical = JSON.stringify({ baseCurrency, rateDate, sortedRates });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Upsert por (source_id, quote_currency, rate_date): reprocesar la misma
 * corrida (mismo día publicado) es idempotente, no duplica filas.
 */
async function saveRates(source, { baseCurrency, rateDate, rates }, fingerprint, sourceUrl) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { currency, rate } of rates) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO reference_rates (source_id, base_currency, quote_currency, rate, rate_date, source_url, fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (source_id, quote_currency, rate_date)
         DO UPDATE SET rate = EXCLUDED.rate, fingerprint = EXCLUDED.fingerprint, retrieved_at = now()`,
        [source.id, baseCurrency, currency, rate, rateDate, sourceUrl, fingerprint],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Actualiza el checkpoint de la fuente: etag/last_modified para la próxima
 * conditional request, el último fingerprint visto, y el contador de
 * fallos consecutivos (para observabilidad — ver /health y /metrics).
 */
async function updateSourceCheckpoint(sourceId, { etag, lastModified, fingerprint, success }) {
  await pool.query(
    `UPDATE reference_rate_sources
     SET etag = $2,
         last_modified = $3,
         last_fingerprint = COALESCE($4, last_fingerprint),
         last_checked_at = now(),
         last_success_at = CASE WHEN $5 THEN now() ELSE last_success_at END,
         consecutive_failures = CASE WHEN $5 THEN 0 ELSE consecutive_failures + 1 END
     WHERE id = $1`,
    [sourceId, etag, lastModified, fingerprint, success],
  );
}

async function getSourceStatus(name) {
  const res = await pool.query('SELECT * FROM reference_rate_sources WHERE name = $1', [name]);
  return res.rows[0] || null;
}

/**
 * Última tasa conocida por moneda (o de una sola moneda si se pide). Es de
 * solo lectura para consumo externo (ver src/http/server.js) — nada del
 * flujo de negocio de transacciones/antifraude depende de esta tabla.
 */
async function latestRates(quoteCurrency) {
  if (quoteCurrency) {
    const res = await pool.query(
      `SELECT quote_currency, base_currency, rate, rate_date, retrieved_at, source_url
       FROM reference_rates
       WHERE quote_currency = $1
       ORDER BY rate_date DESC
       LIMIT 1`,
      [quoteCurrency.toUpperCase()],
    );
    return res.rows;
  }

  const res = await pool.query(`
    SELECT DISTINCT ON (quote_currency) quote_currency, base_currency, rate, rate_date, retrieved_at, source_url
    FROM reference_rates
    ORDER BY quote_currency, rate_date DESC
  `);
  return res.rows;
}

module.exports = {
  getOrCreateSource,
  computeFingerprint,
  saveRates,
  updateSourceCheckpoint,
  getSourceStatus,
  latestRates,
};
