import { describe, expect, it } from "vitest";
import { Redactor, redactPatterns } from "./redact.js";

describe("Redactor", () => {
  it("masks registered secrets everywhere, longest first", () => {
    const r = new Redactor(["supersecret-token-123", "supersecret"]);
    expect(
      r.redact("auth supersecret-token-123 failed; supersecret again"),
    ).toBe("auth [REDACTED] failed; [REDACTED] again");
  });
  it("ignores short values so ordinary text survives", () => {
    const r = new Redactor(["abc", "yes"]);
    expect(r.redact("abc yes")).toBe("abc yes");
    expect(r.size).toBe(0);
  });
  it("masks common token shapes without being told", () => {
    expect(redactPatterns("Authorization: Bearer abcdef1234567890")).toContain(
      "Bearer [REDACTED]",
    );
    expect(redactPatterns("postgres://user:hunter2hunter2@host/db")).toBe(
      "postgres://user:[REDACTED]@host/db",
    );
    expect(redactPatterns("token=abcdefghijklmnopqrstuvwxyz")).toContain(
      "[REDACTED]",
    );
    expect(
      redactPatterns(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
      ),
    ).toBe("[REDACTED PRIVATE KEY]");
  });
  it("injected token in an upstream error never survives", () => {
    const token = "CANARY_TOKEN_9f8e7d6c5b4a";
    const r = new Redactor([token]);
    expect(r.redact(`Upstream said: invalid key ${token}`)).not.toContain(
      token,
    );
  });
});
