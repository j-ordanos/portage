export type AppErrorCode =
  | "UPSTREAM_UNREACHABLE"
  | "UPSTREAM_AUTH"
  | "UPSTREAM_FORBIDDEN"
  | "UPSTREAM_NOT_FOUND"
  | "UPSTREAM_VALIDATION"
  | "UPSTREAM_RATE_LIMIT"
  | "UPSTREAM_5XX"
  | "SCHEMA_DRIFT"
  | "VERSION_UNSUPPORTED"
  | "CONFLICT_NAME"
  | "CONFLICT_DOMAIN"
  | "SECRET_UNAVAILABLE"
  | "RUN_LOCKED"
  | "CONFIG_INVALID"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly hint: string | undefined;
  readonly retryable: boolean;

  constructor(
    code: AppErrorCode,
    message: string,
    options: { hint?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
  }
}
