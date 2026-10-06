const AppError = require('./AppError');

/**
 * Predefined error types for common scenarios
 */
class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed') {
    super(message, 401, 'AUTH_REQUIRED');
  }
}

class AuthorizationError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 403, 'FORBIDDEN');
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 403, 'FORBIDDEN');
  }
}

class BadRequestError extends AppError {
  constructor(message = 'Bad request') {
    super(message, 400, 'BAD_REQUEST');
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409, 'CONFLICT');
  }
}

class ClanFrozenError extends AppError {
  constructor(message = 'This programme has closed. Its cohort clans are read-only.') {
    super(message, 409, 'CLAN_FROZEN');
  }
}

class UnprocessableEntityError extends AppError {
  constructor(message = 'Unable to process the request') {
    super(message, 422, 'UNPROCESSABLE');
  }
}

class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests, please try again later') {
    super(message, 429, 'RATE_LIMITED');
  }
}

class InternalServerError extends AppError {
  constructor(message = 'Internal server error') {
    super(message, 500, 'INTERNAL', false);
  }
}

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  ForbiddenError,
  BadRequestError,
  NotFoundError,
  ConflictError,
  ClanFrozenError,
  UnprocessableEntityError,
  TooManyRequestsError,
  InternalServerError
};
