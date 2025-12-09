import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from 'openai';
import { APIError } from 'openai/error';
import type { OracleResponse, OracleResponseMetadata, TransportFailureReason } from './types.js';
import { formatElapsed } from './format.js';

export type OracleUserErrorCategory = 'file-validation' | 'browser-automation' | 'prompt-validation';

export interface OracleUserErrorDetails {
  [key: string]: unknown;
}

export class OracleUserError extends Error {
  readonly category: OracleUserErrorCategory;
  readonly details?: OracleUserErrorDetails;

  constructor(
    category: OracleUserErrorCategory,
    message: string,
    details?: OracleUserErrorDetails,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'OracleUserError';
    this.category = category;
    this.details = details;
    if (cause) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export class FileValidationError extends OracleUserError {
  constructor(message: string, details?: OracleUserErrorDetails, cause?: unknown) {
    super('file-validation', message, details, cause);
    this.name = 'FileValidationError';
  }
}

export class BrowserAutomationError extends OracleUserError {
  constructor(message: string, details?: OracleUserErrorDetails, cause?: unknown) {
    super('browser-automation', message, details, cause);
    this.name = 'BrowserAutomationError';
  }
}

export class PromptValidationError extends OracleUserError {
  constructor(message: string, details?: OracleUserErrorDetails, cause?: unknown) {
    super('prompt-validation', message, details, cause);
    this.name = 'PromptValidationError';
  }
}

export function asOracleUserError(error: unknown): OracleUserError | null {
  if (error instanceof OracleUserError) {
    return error;
  }
  return null;
}

export class OracleTransportError extends Error {
  readonly reason: TransportFailureReason;

  constructor(reason: TransportFailureReason, message: string, cause?: unknown) {
    super(message);
    this.name = 'OracleTransportError';
    this.reason = reason;
    if (cause) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export class OracleResponseError extends Error {
  readonly metadata: OracleResponseMetadata;
  readonly response?: OracleResponse;

  constructor(message: string, response?: OracleResponse) {
    super(message);
    this.name = 'OracleResponseError';
    this.response = response;
    this.metadata = extractResponseMetadata(response);
  }
}

export function extractResponseMetadata(response?: OracleResponse | null): OracleResponseMetadata {
  if (!response) {
    return {};
  }
  const metadata: OracleResponseMetadata = {
    responseId: response.id,
    status: response.status,
    incompleteReason: response.incomplete_details?.reason ?? undefined,
  };
  const requestId = response._request_id;
  if (requestId !== undefined) {
    metadata.requestId = requestId;
  }
  return metadata;
}

export function toTransportError(error: unknown, model?: string): OracleTransportError {
  if (error instanceof OracleTransportError) {
    return error;
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new OracleTransportError('client-timeout', 'OpenAI request timed out before completion.', error);
  }
  if (error instanceof APIUserAbortError) {
    return new OracleTransportError('client-abort', 'The request was aborted before OpenAI finished responding.', error);
  }
  if (error instanceof APIConnectionError) {
    return new OracleTransportError(
      'connection-lost',
      'Connection to OpenAI dropped before the response completed.',
      error,
    );
  }
  const isApiError = error instanceof APIError || (error as { name?: string })?.name === 'APIError';
  if (isApiError) {
    const apiError = error as APIError & { code?: string; error?: { code?: string; message?: string } };
    const code = apiError.code ?? apiError.error?.code;
    const messageText = apiError.message?.toLowerCase?.() ?? '';
    const apiMessage =
      apiError.error?.message ||
      apiError.message ||
      (apiError.status ? `${apiError.status} OpenAI API error` : 'OpenAI API error');
    // TODO: Remove once gpt-5.1-pro is available via the Responses API.
    if (
      model === 'gpt-5.1-pro' &&
      (code === 'model_not_found' ||
        messageText.includes('does not exist') ||
        messageText.includes('unknown model') ||
        messageText.includes('model_not_found'))
    ) {
      return new OracleTransportError(
        'model-unavailable',
        'gpt-5.1-pro is not yet available on this API base. Using gpt-5-pro until OpenAI enables it. // TODO: Remove once gpt-5.1-pro is available',
        apiError,
      );
    }
    if (apiError.status === 404 || apiError.status === 405) {
      return new OracleTransportError(
        'unsupported-endpoint',
        'HTTP 404/405 from the Responses API; this base URL or gateway likely does not expose /v1/responses. Set OPENAI_BASE_URL to api.openai.com/v1, update your Azure API version/deployment, or use the browser engine.',
        apiError,
      );
    }
    return new OracleTransportError('api-error', apiMessage, apiError);
  }
  return new OracleTransportError(
    'unknown',
    error instanceof Error ? error.message : 'Unknown transport failure.',
    error,
  );
}

export function describeTransportError(error: OracleTransportError, deadlineMs?: number): string {
  switch (error.reason) {
    case 'client-timeout':
      return deadlineMs
        ? `Client-side timeout: OpenAI streaming call exceeded the ${formatElapsed(deadlineMs)} deadline.`
        : 'Client-side timeout: OpenAI streaming call exceeded the configured deadline.';
    case 'connection-lost':
      return 'Connection to OpenAI ended unexpectedly before the response completed.';
    case 'client-abort':
      return 'Request was aborted before OpenAI completed the response.';
    case 'api-error':
      return error.message;
    case 'model-unavailable':
      return error.message;
    case 'unsupported-endpoint':
      return 'The Responses API returned 404/405 — your base URL/gateway probably lacks /v1/responses (check OPENAI_BASE_URL or switch to api.openai.com / browser engine).';
    default:
      return 'OpenAI streaming call ended with an unknown transport error.';
  }
}
