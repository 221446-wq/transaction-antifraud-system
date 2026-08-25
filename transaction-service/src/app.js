const express = require('express');
const transactionRoutes = require('./routes/transactionRoutes');
const errorHandler = require('./middlewares/errorHandler');

/**
 * Arma la app de Express sin levantar el servidor ni conectar Kafka, para
 * poder testearla directamente (p.ej. con supertest) sin efectos
 * secundarios. `index.js` es quien la levanta de verdad.
 */
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

module.exports = app;
