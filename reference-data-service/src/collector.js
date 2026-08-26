const env = require('./config/env');
const logger = require('./logger');
const metrics = require('./metrics');
// Namespace, no desestructurado: los tests monkey-patchean
// `httpClient.fetchWithPoliteness` para simular respuestas de la fuente sin
// red real — ver test/collector.test.js.
const httpClient = require('./http/fetchWithPoliteness');
const { parseEcbRatesHtml, ScrapeMarkupError } = require('./scrapers/ecbRatesScraper');
const repo = require('./repository/referenceRatesRepository');

const SOURCE_NAME = 'ecb-eur-fx';

/**
 * Una corrida de recolección, de punta a punta: conditional request ->
 * parseo -> dedup por fingerprint -> guardado -> checkpoint. Cualquier
 * fallo queda contenido acá (se loguea y se cuenta en /metrics) y nunca se
 * relanza: un problema con esta fuente de datos de referencia no debe
 * afectar el flujo de negocio de transacciones/antifraude, que ni siquiera
 * la conoce — ver docs/WEB_SCRAPING.md, "Por qué la regla de fraude no se
 * ve afectada".
 */
async function collectOnce() {
  const source = await repo.getOrCreateSource(SOURCE_NAME, env.sourceUrl);

  try {
    const response = await httpClient.fetchWithPoliteness(env.sourceUrl, {
      etag: source.etag,
      lastModified: source.last_modified,
    });

    if (response.notModified) {
      logger.info({ source: SOURCE_NAME }, 'reference-data: sin cambios (304 Not Modified).');
      await repo.updateSourceCheckpoint(source.id, {
        etag: source.etag,
        lastModified: source.last_modified,
        fingerprint: null,
        success: true,
      });
      metrics.collectionRunsTotal.inc({ result: 'not_modified' });
      return { result: 'not_modified' };
    }

    const parsed = parseEcbRatesHtml(response.html);
    const fingerprint = repo.computeFingerprint(parsed);

    if (fingerprint === source.last_fingerprint) {
      logger.info(
        { source: SOURCE_NAME, rateDate: parsed.rateDate },
        'reference-data: la fuente respondió 200 pero el contenido no cambió (mismo fingerprint); se omite el guardado.',
      );
      await repo.updateSourceCheckpoint(source.id, {
        etag: response.etag,
        lastModified: response.lastModified,
        fingerprint,
        success: true,
      });
      metrics.collectionRunsTotal.inc({ result: 'unchanged_fingerprint' });
      return { result: 'unchanged_fingerprint' };
    }

    await repo.saveRates(source, parsed, fingerprint, env.sourceUrl);
    await repo.updateSourceCheckpoint(source.id, {
      etag: response.etag,
      lastModified: response.lastModified,
      fingerprint,
      success: true,
    });
    metrics.collectionRunsTotal.inc({ result: 'updated' });
    metrics.currenciesCollectedGauge.set(parsed.rates.length);
    logger.info(
      { source: SOURCE_NAME, rateDate: parsed.rateDate, currencies: parsed.rates.length },
      'reference-data: tasas actualizadas.',
    );
    return { result: 'updated', rateDate: parsed.rateDate, currencies: parsed.rates.length };
  } catch (err) {
    const result = err instanceof ScrapeMarkupError ? 'markup_error' : 'error';
    metrics.collectionRunsTotal.inc({ result });
    await repo.updateSourceCheckpoint(source.id, {
      etag: source.etag,
      lastModified: source.last_modified,
      fingerprint: null,
      success: false,
    });
    logger.error(
      { source: SOURCE_NAME, error: err.message, kind: err.name },
      'reference-data: fallo al recolectar. La regla de fraude no depende de esta fuente y sigue operando con normalidad.',
    );
    return { result, error: err.message };
  }
}

module.exports = { collectOnce, SOURCE_NAME };
