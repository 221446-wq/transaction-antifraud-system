const AppError = require('./AppError');

class NotFoundError extends AppError {
  constructor(message, field = null) {
    super(404, [{ field, message }]);
    this.name = 'NotFoundError';
  }
}

module.exports = NotFoundError;
