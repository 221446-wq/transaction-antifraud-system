const express = require('express');
const metrics = require('../metrics');
const { isConnected: isProducerConnected } = require('../kafka/producer');
const { isConsumerConnected } = require('../events/transactionCreatedConsumer');
const logger = require('../logger');

/**
 * `antifraud-service` no expone ningún endpoint de negocio (es sin estado,
 * ver CONTRACT.md): este servidor HTTP existe solo para /health y /metrics,
 * la extensión opcional de "señales operacionales" del enunciado. Antes el
 * servicio no exponía ningún puerto en absoluto — ver LIMITATIONS.md.
 */
const app = express();

app.get('/health/live', (req, res) => {
  res.json({ status: 'ok', service: 'antifraud-service' });
});

app.get('/health/ready', (req, res) => {
  const checks = {
    kafkaProducer: isProducerConnected() ? 'ok' : 'error',
    kafkaConsumer: isConsumerConnected() ? 'ok' : 'error',
  };
  const ready = Object.values(checks).every((status) => status === 'ok');
  res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'degraded', checks });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metrics.register.contentType);
  res.end(await metrics.register.metrics());
});

function start(port) {
  return app.listen(port, () => {
    logger.info({ port }, 'antifraud-service: servidor HTTP de health/metrics escuchando');
  });
}

module.exports = { app, start };
