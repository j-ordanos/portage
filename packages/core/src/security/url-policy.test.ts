import { describe, expect, it } from "vitest";
import { validateUpstreamUrl } from "./url-policy.js";

describe("upstream URL policy", () => {
  it("allows HTTPS self-host URLs", () => {
    expect(
      validateUpstreamUrl("https://coolify.example", { allowPrivate: true })
        .hostname,
    ).toBe("coolify.example");
  });

  it("blocks metadata and loopback URLs", () => {
    expect(() =>
      validateUpstreamUrl(
        "http://169.254.169.254",
        { allowPrivate: true },
        true,
      ),
    ).toThrow();
    expect(() =>
      validateUpstreamUrl("http://localhost", { allowPrivate: false }, true),
    ).toThrow();
  });

  it("blocks private IPs in hosted mode", () => {
    expect(() =>
      validateUpstreamUrl("https://192.168.1.10", { allowPrivate: false }),
    ).toThrow();
  });

  it("honors the host allowlist", () => {
    expect(() =>
      validateUpstreamUrl("https://other.example", {
        allowPrivate: true,
        allowedHosts: ["allowed.example"],
      }),
    ).toThrow();
  });
});
