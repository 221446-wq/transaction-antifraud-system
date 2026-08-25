const { Kafka } = require('kafkajs');
const env = require('../config/env');

const kafka = new Kafka({
  clientId: env.kafkaClientId,
  brokers: env.kafkaBrokers,
  connectionTimeout: 2000,
  // Reintentos acotados: si el broker no está disponible, queremos enterarnos
  // rápido (para loguear y responder al cliente) en vez de bloquear la
  // petición HTTP con el backoff largo por defecto de KafkaJS (~30s).
  retry: {
    initialRetryTime: 100,
    retries: 3,
  },
});

module.exports = kafka;
