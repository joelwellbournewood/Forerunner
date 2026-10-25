import { type ErrorCode, ForerunnerError, isForerunnerError } from "@forerunner/platform";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * HTTP error shape of the state service. Every error body is `{ code, message, details? }`
 * (the same `ErrorBody` the daemon API uses, ADR 0011). ForerunnerError codes map to HTTP
 * statuses here so routes throw domain errors and never pick status codes by hand.
 */
export type ApiErrorCode =
  | ErrorCode
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "payload_too_large"
  | "schema_mismatch"
  | "bad_signature"
  | "biometric_required"
  | "pairing_invalid";

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ApiErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    status: ContentfulStatusCode,
    code: ApiErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  body(): { code: ApiErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

const STATUS_FOR: Partial<Record<ErrorCode, ContentfulStatusCode>> = {
  not_found: 404,
  version_conflict: 409,
  claim_conflict: 409,
  findings_open: 409,
  validation: 400,
  brief_incomplete: 400,
  approval_required: 403,
  autonomy_insufficient: 403,
  tool_not_allowed: 403,
  path_not_allowed: 403,
  domain_not_allowed: 403,
  secret_not_granted: 403,
  secret_reserved: 403,
  budget_exceeded: 402,
  unavailable: 503,
  not_supported: 501,
  timeout: 504,
  killed: 409,
};

/** Translate anything thrown by a route into an ApiError. Unknown errors become 500 with no detail leak. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (isForerunnerError(e)) {
    const status = STATUS_FOR[e.code] ?? 500;
    const details = status === 500 ? {} : e.details;
    return new ApiError(status, e.code, status === 500 ? "internal error" : e.message, details);
  }
  if (e instanceof SyntaxError) return new ApiError(400, "validation", "malformed JSON body");
  return new ApiError(500, "internal", "internal error");
}

export function unauthorized(message = "authentication required"): ApiError {
  return new ApiError(401, "unauthorized", message);
}

export function forbidden(message: string, details: Record<string, unknown> = {}): ApiError {
  return new ApiError(403, "forbidden", message, details);
}

export function notFound(what: string, id?: string): ApiError {
  return new ApiError(404, "not_found", id ? `${what} ${id} not found` : `${what} not found`, {
    ...(id ? { id } : {}),
  });
}

export function badRequest(message: string, details: Record<string, unknown> = {}): ApiError {
  return new ApiError(400, "validation", message, details);
}

/** Re-throw a ForerunnerError with a stable code (used where repositories lack one). */
export function domainError(code: ErrorCode, message: string, details?: Record<string, unknown>) {
  return new ForerunnerError(code, message, details ? { details } : {});
}
