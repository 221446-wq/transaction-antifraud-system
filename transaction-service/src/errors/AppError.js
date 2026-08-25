/**
 * Error base para fallos "esperados" del dominio (validación, recurso no
 * encontrado, etc). Cualquier AppError lanzado desde un controller es
 * traducido por el middleware centralizado a la respuesta HTTP adecuada,
 * sin que cada endpoint tenga que construirla a mano.
 */
class AppError extends Error {
  constructor(statusCode, errors) {
    super(errors[0]?.message || 'Error');
    this.statusCode = statusCode;
    this.errors = errors;
  }
}

module.exports = AppError;
