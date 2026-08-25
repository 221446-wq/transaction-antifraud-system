const AppError = require('./AppError');

class ValidationError extends AppError {
  constructor(errors) {
    super(400, errors);
    this.name = 'ValidationError';
  }
}

module.exports = ValidationError;
