const { Kafka } = require('kafkajs');
const env = require('../config/env');

const kafka = new Kafka({
  clientId: env.kafkaClientId,
  brokers: env.kafkaBrokers,
  connectionTimeout: 2000,
  retry: {
    initialRetryTime: 100,
    retries: 3,
  },
});

module.exports = kafka;
