import { AppError } from "../errors.js";

export type FailureDisposition =
  | "pause_failed"
  | "retry"
  | "cancelled"
  | "manual"
  | "purge";

export function failureDisposition(error: unknown): FailureDisposition {
  if (error instanceof AppError) {
    if (error.code === "UPSTREAM_AUTH") return "manual";
    if (error.code === "UPSTREAM_RATE_LIMIT" || error.code === "UPSTREAM_5XX") {
      return "retry";
    }
    if (error.code === "SECRET_UNAVAILABLE") return "manual";
  }
  if (error instanceof Error && error.message === "Run cancelled") {
    return "cancelled";
  }
  if (error instanceof Error && error.message === "Vault missing") {
    return "purge";
  }
  return "pause_failed";
}
