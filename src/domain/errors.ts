/** Base class for expected, business-level failures. Never retried. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input from a client failed validation (maps to HTTP 400). */
export class ValidationError extends DomainError {
  readonly code = 'validation_failed';
}

/** The resource does not exist *for this tenant* (maps to HTTP 404, never 403). */
export class DocumentNotFoundError extends DomainError {
  readonly code = 'document_not_found';
}

/** A state transition was attempted from a state that does not allow it. */
export class InvalidTransitionError extends DomainError {
  readonly code = 'invalid_transition';
}
