/**
 * Prueba `collectOnce` de punta a punta contra Postgres real, sin red real:
 * `t.mock.method` reemplaza `httpClient.fetchWithPoliteness` por un stub
 * que devuelve HTML de un fixture (ver test/fixtures/). Funciona porque
 * collector.js importa ese módulo como namespace en vez de desestructurarlo
 * — ver el comentario en ese archivo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/db/pool');
const httpClient = require('../src/http/fetchWithPoliteness');
const { collectOnce, SOURCE_NAME } = require('../src/collector');

const GOOD_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'ecb-rates.html'), 'utf8');
const CHANGED_MARKUP_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'ecb-rates-changed-markup.html'), 'utf8');

async function resetSourceState() {
  await pool.query(
    'DELETE FROM reference_rates WHERE source_id IN (SELECT id FROM reference_rate_sources WHERE name = $1)',
    [SOURCE_NAME],
  );
  await pool.query('DELETE FROM reference_rate_sources WHERE name = $1', [SOURCE_NAME]);
}

test.beforeEach(resetSourceState);
test.after(async () => {
  await resetSourceState();
  await pool.end();
});

test('primera corrida: guarda las tasas y deja el checkpoint (etag/fingerprint) para la próxima', async (t) => {
  t.mock.method(httpClient, 'fetchWithPoliteness', async () => ({
    notModified: false,
    html: GOOD_HTML,
    etag: '"abc123"',
    lastModified: 'Wed, 26 Aug 2026 16:00:00 GMT',
  }));

  const outcome = await collectOnce();
  assert.equal(outcome.result, 'updated');
  assert.ok(outcome.currencies > 20);

  const { rows } = await pool.query('SELECT * FROM reference_rate_sources WHERE name = $1', [SOURCE_NAME]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].etag, '"abc123"');
  assert.ok(rows[0].last_fingerprint);
  assert.equal(rows[0].consecutive_failures, 0);

  const ratesCount = await pool.query('SELECT count(*)::int FROM reference_rates WHERE source_id = $1', [rows[0].id]);
  assert.ok(ratesCount.rows[0].count > 20);
});

test('corrida repetida con el mismo contenido (mismo fingerprint): no duplica filas', async (t) => {
  t.mock.method(httpClient, 'fetchWithPoliteness', async () => ({
    notModified: false,
    html: GOOD_HTML,
    etag: '"abc123"',
    lastModified: 'Wed, 26 Aug 2026 16:00:00 GMT',
  }));

  await collectOnce();
  const firstCount = await pool.query('SELECT count(*)::int FROM reference_rates');

  const outcome = await collectOnce();
  assert.equal(outcome.result, 'unchanged_fingerprint');

  const secondCount = await pool.query('SELECT count(*)::int FROM reference_rates');
  assert.equal(secondCount.rows[0].count, firstCount.rows[0].count);
});

test('respuesta 304 (Not Modified): no hace ningún guardado', async (t) => {
  t.mock.method(httpClient, 'fetchWithPoliteness', async () => ({ notModified: true }));

  const outcome = await collectOnce();
  assert.equal(outcome.result, 'not_modified');

  const ratesCount = await pool.query('SELECT count(*)::int FROM reference_rates');
  assert.equal(ratesCount.rows[0].count, 0);
});

test('si el marcado de la fuente cambió, se registra el fallo (consecutive_failures) sin lanzar y sin guardar nada', async (t) => {
  t.mock.method(httpClient, 'fetchWithPoliteness', async () => ({
    notModified: false,
    html: CHANGED_MARKUP_HTML,
    etag: '"xyz"',
    lastModified: null,
  }));

  const outcome = await collectOnce();
  assert.equal(outcome.result, 'markup_error');

  const { rows } = await pool.query('SELECT * FROM reference_rate_sources WHERE name = $1', [SOURCE_NAME]);
  assert.equal(rows[0].consecutive_failures, 1);

  const ratesCount = await pool.query('SELECT count(*)::int FROM reference_rates');
  assert.equal(ratesCount.rows[0].count, 0);
});

test('un fallo de red no lanza fuera de collectOnce (queda contenido, no tumba el scheduler)', async (t) => {
  t.mock.method(httpClient, 'fetchWithPoliteness', async () => {
    throw new Error('ECONNREFUSED (simulado)');
  });

  await assert.doesNotReject(collectOnce());
});
