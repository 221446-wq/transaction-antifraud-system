const express = require('express');
const env = require('./config/env');

const app = express();
app.use(express.json());

// Endpoint de salud básico: útil para confirmar que el servicio levantó
// correctamente, antes de que existan los endpoints reales de negocio.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'transaction-service' });
});

app.listen(env.port, () => {
  console.log(`transaction-service escuchando en el puerto ${env.port}`);
});
