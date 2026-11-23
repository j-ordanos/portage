import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { createCoolifyReader } from "./coolify.js";
import { createDokployClient } from "./dokploy.js";
import { requestUpstream } from "./http.js";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("upstream HTTP transport", () => {
  it("maps authentication and forbidden responses", async () => {
    await expect(
      requestUpstream({
        baseUrl: "https://upstream.invalid",
        path: "/test",
        retries: 0,
        fetchImpl: vi.fn(async () =>
          jsonResponse({ message: "unauthorized" }, 401),
        ),
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_AUTH" });

    await expect(
      requestUpstream({
        baseUrl: "https://upstream.invalid",
        path: "/test",
        retries: 0,
        fetchImpl: vi.fn(async () =>
          jsonResponse({ message: "forbidden" }, 403),
        ),
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_FORBIDDEN" });
  });

  it("refuses redirects", async () => {
    await expect(
      requestUpstream({
        baseUrl: "https://upstream.invalid",
        path: "/test",
        retries: 0,
        fetchImpl: vi.fn(async () => new Response(null, { status: 302 })),
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNREACHABLE" });
  });

  it("maps HTML responses to actionable upstream validation", async () => {
    await expect(
      requestUpstream({
        baseUrl: "https://upstream.invalid",
        path: "/api/project.all",
        retries: 0,
        fetchImpl: vi.fn(
          async () =>
            new Response("<html><body>Login</body></html>", {
              status: 200,
              headers: { "Content-Type": "text/html" },
            }),
        ),
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_VALIDATION",
      hint: expect.stringContaining("API host"),
    });
  });

  it("uses the configured URL validator", async () => {
    await expect(
      requestUpstream({
        baseUrl: "https://localhost",
        path: "/test",
        retries: 0,
        validateUrl: () => {
          throw new AppError(
            "UPSTREAM_UNREACHABLE",
            "Blocked private upstream",
          );
        },
        fetchImpl: vi.fn(async () => jsonResponse({ ok: true })),
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNREACHABLE" });
  });
});

describe("Coolify read-only client", () => {
  it("probes and lists resources through GET requests", async () => {
    const requests: Array<{ method: string | undefined; url: string }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof URL ? input : new URL(String(input));
        requests.push({ method: init?.method, url: url.toString() });
        if (url.pathname.endsWith("/version"))
          return jsonResponse({ version: "4.3.1" });
        if (url.pathname.endsWith("/applications"))
          return jsonResponse([{ uuid: "app-1" }]);
        return jsonResponse([]);
      },
    );

    const reader = createCoolifyReader({
      baseUrl: "https://coolify.example",
      token: "canary-token",
      fetchImpl,
    });

    await expect(reader.probe()).resolves.toMatchObject({ version: "4.3.1" });
    await expect(reader.listApplications()).resolves.toEqual([
      { uuid: "app-1" },
    ]);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("has no write methods in source text", async () => {
    const source = await readFile(
      new URL("./coolify.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\b(?:POST|PUT|PATCH|DELETE)\b/);
  });
});

describe("Dokploy client", () => {
  it("probes x-api-key auth and returns project data", async () => {
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof URL ? input : new URL(String(input));
        if (url.pathname.endsWith("/project.all")) {
          expect(init?.headers).toMatchObject({ "x-api-key": "dokploy-key" });
          return jsonResponse([]);
        }
        if (url.pathname.endsWith("/settings.getDokployVersion")) {
          return jsonResponse({ version: "0.31.4" });
        }
        return jsonResponse([], 404);
      },
    );
    const client = createDokployClient({
      baseUrl: "https://dokploy.example",
      apiKey: "dokploy-key",
      fetchImpl,
    });

    await expect(client.probe()).resolves.toEqual({
      version: "0.31.4",
      authStyle: "x-api-key",
    });
  });

  it("falls back to Authorization when x-api-key is rejected", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers =
          init?.headers instanceof Headers
            ? Object.fromEntries(init.headers.entries())
            : ((init?.headers ?? {}) as Record<string, string>);
        if ("x-api-key" in headers) {
          return jsonResponse({ message: "unauthorized" }, 401);
        }
        return jsonResponse([]);
      },
    );
    const client = createDokployClient({
      baseUrl: "https://dokploy.example",
      apiKey: "dokploy-key",
      fetchImpl,
    });

    await expect(client.probe()).resolves.toMatchObject({
      authStyle: "authorization",
    });
  });
});
