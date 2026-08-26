const AppError = require('../errors/AppError');
const logger = require('../logger');

/**
 * Punto único de traducción de errores a respuestas HTTP. Todo error termina
 * acá (vía asyncHandler o next(err)) y sale con el mismo formato JSON:
 * { errors: [{ field, message }] }.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  // express.json() lanza un SyntaxError cuando el body no es JSON válido,
  // antes de llegar a ninguna ruta.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      errors: [{ field: 'body', message: 'El cuerpo de la petición debe ser JSON válido.' }],
    });
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ errors: err.errors });
  }

  logger.error({ error: err.message, stack: err.stack }, 'Error no manejado en un request HTTP');
  return res.status(500).json({
    errors: [{ field: null, message: 'Error interno del servidor.' }],
  });
}

module.exports = errorHandler;
