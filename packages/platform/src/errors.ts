/**
 * Error taxonomy shared by every package. Codes are stable strings so the UI,
 * logs and tests can match on them without parsing messages.
 */
export type ErrorCode =
  | "budget_exceeded"
  | "step_cap_exceeded"
  | "depth_exceeded"
  | "timeout"
  | "tool_not_allowed"
  | "path_not_allowed"
  | "domain_not_allowed"
  | "secret_not_granted"
  /** A reserved secret name (`forerunner.*`, the install wrapping key) in a grant or a reference. */
  | "secret_reserved"
  | "autonomy_insufficient"
  | "approval_required"
  | "claim_conflict"
  | "version_conflict"
  | "not_found"
  | "identity_ambiguous"
  | "validation"
  | "brief_incomplete"
  | "findings_open"
  | "killed"
  | "provider_error"
  | "provider_auth"
  | "provider_rate_limit"
  /**
   * The credential's plan or account limit is reached (a Claude subscription's usage limit, an
   * API key's credit balance or spend limit): another credential may serve, this one rests
   * until its reset (ADR 0100). Distinct from `provider_rate_limit`, a short-lived throttle.
   */
  | "provider_usage_limit"
  | "not_supported"
  | "unavailable"
  | "injection_suspected"
  /** A private-memory row was about to enter a shared store (ADR 0002; spelled as the ADR names it). */
  | "MEMORY_SCOPE_VIOLATION"
  | "internal";

export class ForerunnerError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ForerunnerError";
    this.code = code;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
  }

  toJSON(): {
    code: ErrorCode;
    message: string;
    details: Record<string, unknown>;
    retryable: boolean;
  } {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

export function isForerunnerError(e: unknown, code?: ErrorCode): e is ForerunnerError {
  return e instanceof ForerunnerError && (code === undefined || e.code === code);
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
