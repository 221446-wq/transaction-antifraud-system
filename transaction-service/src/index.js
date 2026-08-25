const express = require('express');
const env = require('./config/env');
const transactionRoutes = require('./routes/transactionRoutes');
const { ensureConnected: ensureKafkaProducerConnected } = require('./kafka/producer');

const app = express();
app.use(express.json());

// Endpoint de salud básico: útil para confirmar que el servicio levantó
// correctamente, antes de que existan los endpoints reales de negocio.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'transaction-service' });
});

app.use(transactionRoutes);

// Body JSON malformado: express.json() lanza un SyntaxError antes de llegar
// a las rutas, se traduce a un 400 en vez del 500 genérico de Express.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      errors: [{ field: 'body', message: 'El cuerpo de la petición debe ser JSON válido.' }],
    });
  }
  return next(err);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ errors: [{ field: null, message: 'Error interno del servidor.' }] });
});

app.listen(env.port, () => {
  console.log(`transaction-service escuchando en el puerto ${env.port}`);
});

// Intento de conexión temprana al productor de Kafka: si el broker no está
// disponible al arrancar, el servicio sigue levantando igual (se reintenta
// de forma lazy en cada publish, ver src/kafka/producer.js).
ensureKafkaProducerConnected().catch((err) => {
  console.error('No se pudo conectar el productor de Kafka al arrancar', err);
});
