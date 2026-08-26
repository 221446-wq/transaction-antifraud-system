const client = require('prom-client');

/**
 * Métricas Prometheus del servicio, expuestas en GET /metrics (ver
 * src/http/server.js). Registro propio, igual que en los otros dos
 * servicios, para no pisarse con el registro global de prom-client si
 * conviviera con otra librería que también lo use.
 */
const register = new client.Registry();
client.collectDefaultMetrics({ register });

// Una corrida por ciclo del scheduler, sea cual sea el resultado — el label
// `result` es la señal principal para saber si la recolección está sana
// (mayoría "not_modified"/"unchanged_fingerprint") o rota
// ("markup_error"/"error" repitiéndose).
const collectionRunsTotal = new client.Counter({
  name: 'reference_data_collection_runs_total',
  help: 'Corridas de recolección, por resultado (updated | not_modified | unchanged_fingerprint | markup_error | error).',
  labelNames: ['result'],
  registers: [register],
});

const currenciesCollectedGauge = new client.Gauge({
  name: 'reference_data_currencies_collected',
  help: 'Cantidad de monedas guardadas en la última corrida exitosa con datos nuevos.',
  registers: [register],
});

module.exports = { register, collectionRunsTotal, currenciesCollectedGauge };
