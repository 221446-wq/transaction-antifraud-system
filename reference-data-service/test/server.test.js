const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const pool = require('../src/db/pool');
const { app } = require('../src/http/server');
const { SOURCE_NAME } = require('../src/collector');
const repo = require('../src/repository/referenceRatesRepository');

async function cleanup() {
  await pool.query(
    'DELETE FROM reference_rates WHERE source_id IN (SELECT id FROM reference_rate_sources WHERE name = $1)',
    [SOURCE_NAME],
  );
  await pool.query('DELETE FROM reference_rate_sources WHERE name = $1', [SOURCE_NAME]);
}

test.beforeEach(cleanup);
test.after(async () => {
  await cleanup();
  await pool.end();
});

test('GET /health/live responde ok sin depender de nada externo', async () => {
  const res = await request(app).get('/health/live');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('GET /health/ready responde ok cuando Postgres está disponible', async () => {
  const res = await request(app).get('/health/ready');
  assert.equal(res.status, 200);
  assert.equal(res.body.checks.postgres, 'ok');
});

test('GET /reference-rates/:currency responde 404 si no hay datos guardados', async () => {
  const res = await request(app).get('/reference-rates/USD');
  assert.equal(res.status, 404);
  assert.match(res.body.errors[0].message, /USD/);
});

test('GET /reference-rates/:currency devuelve la última tasa guardada', async () => {
  const source = await repo.getOrCreateSource(SOURCE_NAME, 'https://example.test/rates');
  const fingerprint = repo.computeFingerprint({ baseCurrency: 'EUR', rateDate: '2026-08-26', rates: [{ currency: 'USD', rate: 1.1669 }] });
  await repo.saveRates(source, { baseCurrency: 'EUR', rateDate: '2026-08-26', rates: [{ currency: 'USD', rate: 1.1669 }] }, fingerprint, 'https://example.test/rates');

  const res = await request(app).get('/reference-rates/usd');
  assert.equal(res.status, 200);
  assert.equal(res.body.rate.quote_currency, 'USD');
  assert.equal(Number(res.body.rate.rate), 1.1669);
});

test('GET /reference-rates devuelve todas las monedas guardadas', async () => {
  const source = await repo.getOrCreateSource(SOURCE_NAME, 'https://example.test/rates');
  const parsed = { baseCurrency: 'EUR', rateDate: '2026-08-26', rates: [{ currency: 'USD', rate: 1.1669 }, { currency: 'JPY', rate: 185.62 }] };
  const fingerprint = repo.computeFingerprint(parsed);
  await repo.saveRates(source, parsed, fingerprint, 'https://example.test/rates');

  const res = await request(app).get('/reference-rates');
  assert.equal(res.status, 200);
  assert.equal(res.body.rates.length, 2);
});
