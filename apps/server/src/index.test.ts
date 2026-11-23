import { describe, expect, it } from "vitest";
import { createApp } from "./index.js";

describe("health endpoint", () => {
  it("returns the service status", async () => {
    const response = await createApp().request("http://localhost/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: "0.1.0" });
  });

  describe("login endpoint", () => {
    it("rejects an incorrect password", async () => {
      process.env.ADMIN_PASSWORD_HASH = "sha256:incorrect";
      const response = await createApp().request(
        "http://localhost/api/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "wrong" }),
        },
      );
      expect(response.status).toBe(401);
    });

    it("sets a session cookie after successful login", async () => {
      const hash = await import("argon2").then((argon2) =>
        argon2.default.hash("dev-password", { type: argon2.default.argon2id }),
      );
      process.env.ADMIN_PASSWORD_HASH = hash;
      const response = await createApp().request(
        "http://localhost/api/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "dev-password" }),
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("migrator_session=");
    });

    it("rejects unauthenticated connection mutations", async () => {
      const response = await createApp().request(
        "http://localhost/api/connections/coolify/test",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "migrator",
          },
          body: JSON.stringify({
            url: "https://coolify.example",
            token: "token",
          }),
        },
      );
      expect(response.status).toBe(401);
    });
  });
});
