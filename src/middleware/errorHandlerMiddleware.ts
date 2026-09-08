import { Request, Response, NextFunction } from 'express';
import { DomainError, InvalidTimeWindowError, InvalidMoneyError, InvalidCapacityError, EmptyTicketTypesError, InvalidStateTransitionError, InsufficientInventoryError } from '../shared/domain/DomainError.js';
import { RequestWithCorrelation } from './correlationIdMiddleware.js';

export function errorHandlerMiddleware(err: any, req: RequestWithCorrelation, res: Response, next: NextFunction): void {
  const correlationId = req.correlationId || 'unknown';
  const timestamp = new Date().toISOString();

  // Syntax / Malformed JSON body
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: {
        code: 'MALFORMED_JSON',
        message: 'Malformed JSON payload in request body',
        timestamp,
        correlationId,
      },
    });
    return;
  }

  // Domain Exceptions
  if (err instanceof DomainError) {
    let statusCode = 400;
    let code = 'DOMAIN_ERROR';

    if (err instanceof InvalidTimeWindowError || err instanceof InvalidMoneyError || err instanceof InvalidCapacityError) {
      statusCode = 400;
      code = err.name.replace(/([A-Z])/g, '_$1').toUpperCase().substring(1);
    } else if (err instanceof EmptyTicketTypesError || err instanceof InvalidStateTransitionError || err instanceof InsufficientInventoryError) {
      statusCode = 409; // Conflict
      code = err.name.replace(/([A-Z])/g, '_$1').toUpperCase().substring(1);
    }

    res.status(statusCode).json({
      error: {
        code,
        message: err.message,
        timestamp,
        correlationId,
      },
    });
    return;
  }

  // Fallback 500
  console.error('[UnhandledError]', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal error occurred',
      timestamp,
      correlationId,
    },
  });
}
