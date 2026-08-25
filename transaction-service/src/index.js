const express = require('express');
const env = require('./config/env');
const transactionRoutes = require('./routes/transactionRoutes');
const errorHandler = require('./middlewares/errorHandler');
const { ensureConnected: ensureKafkaProducerConnected } = require('./kafka/producer');
const { startFraudDecisionConsumer } = require('./events/fraudDecisionConsumer');

const app = express();
app.use(express.json());

// Endpoint de salud básico: útil para confirmar que el servicio levantó
// correctamente, antes de que existan los endpoints reales de negocio.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'transaction-service' });
});

app.use(transactionRoutes);

// Cualquier ruta no definida responde con el mismo formato JSON que el resto
// de la API, en vez del HTML por defecto de Express.
app.use((req, res) => {
  res.status(404).json({
    errors: [{ field: null, message: `Recurso no encontrado: ${req.method} ${req.originalUrl}.` }],
  });
});

app.use(errorHandler);

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
