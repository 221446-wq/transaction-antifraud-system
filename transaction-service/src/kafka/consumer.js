const kafka = require('./kafkaClient');

// groupId estable: los offsets quedan asociados a este consumer group, así
// un reinicio del servicio retoma donde se quedó en vez de reprocesar todo.
const GROUP_ID = 'transaction-service';

const consumer = kafka.consumer({ groupId: GROUP_ID });

module.exports = { consumer, GROUP_ID };
