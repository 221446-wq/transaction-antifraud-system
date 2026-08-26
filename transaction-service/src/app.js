const crypto = require('node:crypto');
const express = require('express');
const transactionRoutes = require('./routes/transactionRoutes');
const errorHandler = require('./middlewares/errorHandler');
const metrics = require('./metrics');
const prisma = require('./db/prismaClient');
const { isConnected: isKafkaProducerConnected } = require('./kafka/producer');
const graphqlYoga = require('./graphql/server');
const logger = require('./logger');

/**
 * Arma la app de Express sin levantar el servidor ni conectar Kafka, para
 * poder testearla directamente (p.ej. con supertest) sin efectos
 * secundarios. `index.js` es quien la levanta de verdad.
 */
const app = express();
app.use(express.json());

// Correlation id por request: si el cliente no manda uno, se genera acá.
// Se propaga en la respuesta y en cada log de la request, para poder seguir
// una petición HTTP puntual a través de los logs — es la base de la
// "tracing" liviana de este proyecto (ver DECISIONS.md, "Observabilidad").
app.use((req, res, next) => {
  req.correlationId = req.get('x-correlation-id') || crypto.randomUUID();
  res.set('x-correlation-id', req.correlationId);
  next();
});

// Un log por request completado (no al empezar, para poder incluir el
// status code y la duración real) — reemplaza el log de acceso que un
// framework más grande traería por defecto.
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info(
      {
        correlationId: req.correlationId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      },
      'request',
    );
  });
  next();
});

// Liveness: el proceso está vivo y responde. No depende de nada externo.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'transaction-service' });
});
app.get('/health/live', (req, res) => {
  res.json({ status: 'ok', service: 'transaction-service' });
});

// Readiness: el servicio puede realmente atender tráfico. Chequea las
// dependencias de las que depende cada endpoint: Postgres (todo el CRUD) y
// el productor de Kafka (indirectamente, vía el outbox relay). Un fallo acá
// no debería tumbar el proceso, pero sí sacarlo de un load balancer.
app.get('/health/ready', async (req, res) => {
  const checks = { postgres: 'ok', kafkaProducer: 'ok' };

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    checks.postgres = 'error';
  }

  if (!isKafkaProducerConnected()) {
    checks.kafkaProducer = 'error';
  }

  const ready = Object.values(checks).every((status) => status === 'ok');
  res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'degraded', checks });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metrics.register.contentType);
  res.end(await metrics.register.metrics());
});

// GraphQL además de REST (ver src/graphql/schema.js) — expone la misma
// capa de servicio que las rutas REST de abajo, no una reimplementación.
app.use('/graphql', graphqlYoga);

app.use(transactionRoutes);

// Cualquier ruta no definida responde con el mismo formato JSON que el resto
// de la API, en vez del HTML por defecto de Express.
app.use((req, res) => {
  res.status(404).json({
    errors: [{ field: null, message: `Recurso no encontrado: ${req.method} ${req.originalUrl}.` }],
  });
});

app.use(errorHandler);

module.exports = app;
