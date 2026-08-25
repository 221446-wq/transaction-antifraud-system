const app = require('./app');
const env = require('./config/env');
const { ensureConnected: ensureKafkaProducerConnected } = require('./kafka/producer');
const { startFraudDecisionConsumer } = require('./events/fraudDecisionConsumer');

app.listen(env.port, () => {
  console.log(`transaction-service escuchando en el puerto ${env.port}`);
});

// Intento de conexión temprana al productor de Kafka: si el broker no está
// disponible al arrancar, el servicio sigue levantando igual (se reintenta
// de forma lazy en cada publish, ver src/kafka/producer.js).
ensureKafkaProducerConnected().catch((err) => {
  console.error('No se pudo conectar el productor de Kafka al arrancar', err);
});

// El consumer de decisiones antifraude corre en segundo plano: si falla acá,
// se loguea pero no se tumba el servicio HTTP.
startFraudDecisionConsumer().catch((err) => {
  console.error('El consumer de transaction.fraud-decision se detuvo inesperadamente', err);
});
