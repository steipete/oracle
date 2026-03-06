import { describe, expect, test } from 'vitest';

import { toTransportError } from '@src/oracle/errors.js';

// Minimal stub matching openai APIError signature without pulling undici Headers.
class FakeApiError extends Error {
  status: number;
  error: { message?: string; code?: string; param?: string };
  code?: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'APIError';
    this.status = 400;
    this.error = { message, code, param: 'model' };
    this.code = code;
  }
}

describe('toTransportError', () => {
  test('maps gpt-5.4-pro model_not_found to model-unavailable with guidance', () => {
    const apiError = new FakeApiError('The requested model does not exist', 'model_not_found');
    const transport = toTransportError(apiError, 'gpt-5.4-pro');
    expect(transport.reason).toBe('model-unavailable');
    expect(transport.message).toContain('gpt-5.4-pro');
    expect(transport.message).toContain('gpt-5-pro');
  });

  test('maps generic API error to api-error with message', () => {
    const apiError = new FakeApiError('Rate limit exceeded', 'rate_limit_exceeded');
    const transport = toTransportError(apiError, 'gpt-5.1');
    expect(transport.reason).toBe('api-error');
    expect(transport.message).toContain('Rate limit exceeded');
  });
});
