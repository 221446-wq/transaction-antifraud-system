const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseEcbRatesHtml, ScrapeMarkupError } = require('../src/scrapers/ecbRatesScraper');

const GOOD_FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'ecb-rates.html'), 'utf8');
const CHANGED_MARKUP_FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'ecb-rates-changed-markup.html'), 'utf8');

test('extrae la fecha de referencia y una lista de tasas de un HTML real del BCE', () => {
  const result = parseEcbRatesHtml(GOOD_FIXTURE);

  assert.equal(result.baseCurrency, 'EUR');
  assert.match(result.rateDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(result.rates.length > 20, `esperaba varias decenas de monedas, encontré ${result.rates.length}`);

  const usd = result.rates.find((r) => r.currency === 'USD');
  assert.ok(usd, 'debería incluir USD');
  assert.ok(usd.rate > 0);

  // No debería haber duplicados de moneda en una misma corrida.
  const currencies = result.rates.map((r) => r.currency);
  assert.equal(new Set(currencies).size, currencies.length);
});

test('cada tasa extraída es un número finito y positivo', () => {
  const result = parseEcbRatesHtml(GOOD_FIXTURE);
  for (const { currency, rate } of result.rates) {
    assert.ok(Number.isFinite(rate) && rate > 0, `tasa inválida para ${currency}: ${rate}`);
  }
});

test('si el marcado de la fuente cambia (selector de la tabla ya no existe), lanza ScrapeMarkupError en vez de devolver datos vacíos o incorrectos en silencio', () => {
  assert.throws(
    () => parseEcbRatesHtml(CHANGED_MARKUP_FIXTURE),
    ScrapeMarkupError,
  );
});

test('un HTML completamente ajeno a la fuente también falla de forma explícita', () => {
  assert.throws(
    () => parseEcbRatesHtml('<html><body><p>Not the ECB page</p></body></html>'),
    ScrapeMarkupError,
  );
});
