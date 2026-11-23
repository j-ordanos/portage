import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { failureDisposition } from "./failure-matrix.js";

describe("failure matrix", () => {
  it("maps auth and secrets to manual handling", () => {
    expect(
      failureDisposition(new AppError("UPSTREAM_AUTH", "Invalid key")),
    ).toBe("manual");
    expect(
      failureDisposition(new AppError("SECRET_UNAVAILABLE", "Missing secret")),
    ).toBe("manual");
  });

  it("maps 5xx and rate limits to retry", () => {
    expect(
      failureDisposition(new AppError("UPSTREAM_5XX", "Server error")),
    ).toBe("retry");
    expect(
      failureDisposition(new AppError("UPSTREAM_RATE_LIMIT", "Rate limited")),
    ).toBe("retry");
  });

  it("maps cancellation, vault loss, and unknown failures", () => {
    expect(failureDisposition(new Error("Run cancelled"))).toBe("cancelled");
    expect(failureDisposition(new Error("Vault missing"))).toBe("purge");
    expect(failureDisposition(new Error("Unexpected"))).toBe("pause_failed");
  });
});
