const kafka = require('./kafkaClient');
const env = require('../config/env');

// groupId estable: los offsets quedan asociados a este consumer group, así
// un reinicio del servicio retoma donde se quedó en vez de reprocesar todo.
const consumer = kafka.consumer({ groupId: env.kafkaConsumerGroupId });

module.exports = { consumer };
