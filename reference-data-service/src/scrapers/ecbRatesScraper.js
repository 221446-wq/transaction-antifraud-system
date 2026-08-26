const cheerio = require('cheerio');

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Error dedicado (no un Error genérico) para que quien llama pueda
 * distinguir "la fuente cambió su HTML" de un fallo de red — son
 * situaciones que se manejan distinto (ver collector.js: un fallo de red
 * se reintenta, un cambio de marcado no tiene sentido reintentarlo, hay que
 * enterarse y arreglar el selector).
 */
class ScrapeMarkupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScrapeMarkupError';
  }
}

function parseReferenceDate(text) {
  const match = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(text.trim());
  if (!match) {
    throw new ScrapeMarkupError(`Fecha de referencia con formato inesperado: "${text}". El marcado de la fuente puede haber cambiado.`);
  }
  const [, day, monthName, year] = match;
  const month = MONTHS[monthName.toLowerCase()];
  if (!month) {
    throw new ScrapeMarkupError(`Mes no reconocido en la fecha de referencia: "${text}".`);
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Extrae las tasas de cambio de referencia EUR -> X de la página del BCE.
 * Lanza ScrapeMarkupError (no devuelve un resultado vacío/parcial en
 * silencio) si los selectores esperados no aparecen — "hacer visibles los
 * cambios de marcado en vez de aceptar datos malos calladamente", como pide
 * la extensión opcional del enunciado. Ver test/ecbRatesScraper.test.js,
 * que ejercita esto con un fixture de HTML con la marca cambiada.
 */
function parseEcbRatesHtml(html) {
  const $ = cheerio.load(html);

  const dateText = $('.jumbo-box .upper h3').first().text().trim();
  if (!dateText) {
    throw new ScrapeMarkupError('No se encontró la fecha de referencia (selector ".jumbo-box .upper h3"). El marcado de la fuente puede haber cambiado.');
  }
  const rateDate = parseReferenceDate(dateText);

  const rows = $('table.forextable tbody tr');
  if (rows.length === 0) {
    throw new ScrapeMarkupError('No se encontraron filas en "table.forextable tbody tr". El marcado de la fuente puede haber cambiado.');
  }

  const rates = [];
  rows.each((_, row) => {
    const currency = $(row).find('td.currency').first().text().trim();
    const rateText = $(row).find('td.spot .rate').first().text().trim();

    if (!currency || !rateText) {
      throw new ScrapeMarkupError(
        `Fila de tasas sin moneda o valor reconocibles (currency="${currency}", rate="${rateText}"). El marcado de la fuente puede haber cambiado.`,
      );
    }

    const rate = Number(rateText);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new ScrapeMarkupError(`Tasa no numérica o inválida para ${currency}: "${rateText}".`);
    }

    rates.push({ currency, rate });
  });

  return { baseCurrency: 'EUR', rateDate, rates };
}

module.exports = { parseEcbRatesHtml, ScrapeMarkupError };
