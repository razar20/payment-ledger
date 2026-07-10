export class DomainError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export const ERR = {
  NOT_FOUND: 'NOT_FOUND',
  UNBALANCED: 'UNBALANCED_TRANSACTION',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  INVALID_STATE: 'INVALID_STATE',
  OVERPAYMENT: 'OVERPAYMENT',
  DUPLICATE: 'DUPLICATE',
};
