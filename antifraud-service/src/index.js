const env = require('./config/env');
const { ensureConnected: ensureKafkaProducerConnected } = require('./kafka/producer');
const { startTransactionCreatedConsumer } = require('./events/transactionCreatedConsumer');

console.log(
  `antifraud-service inicializado (clientId=${env.kafkaClientId}, brokers=${env.kafkaBrokers.join(',')})`,
);

// Intento de conexión temprana al productor de Kafka: si el broker no está
// disponible al arrancar, el servicio sigue levantando igual (se reintenta
// de forma lazy en cada publish, ver src/kafka/producer.js).
ensureKafkaProducerConnected().catch((err) => {
  console.error('No se pudo conectar el productor de Kafka al arrancar', err);
});

startTransactionCreatedConsumer().catch((err) => {
  console.error('El consumer de transaction.created se detuvo inesperadamente', err);
});
