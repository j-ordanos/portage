import { AppError } from "../errors.js";

export interface HttpOptions {
  baseUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  validateUrl?: (url: URL) => void;
}

export interface RequestOptions extends HttpOptions {
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  retries?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorForStatus(
  status: number,
  message: string,
  retryAfter?: string,
): AppError {
  if (status === 401) {
    return new AppError("UPSTREAM_AUTH", "Upstream authentication failed", {
      hint: "Check that the API credential is valid and has not been revoked.",
    });
  }
  if (status === 403) {
    return new AppError("UPSTREAM_FORBIDDEN", "Upstream permission denied", {
      hint: "Create a token with the read permissions required by this migration.",
    });
  }
  if (status === 404) {
    return new AppError(
      "UPSTREAM_NOT_FOUND",
      "Upstream resource was not found",
    );
  }
  if (status === 405) {
    return new AppError(
      "UPSTREAM_VALIDATION",
      "Upstream endpoint rejected the request method",
      {
        hint: "The installed version may expose a different API method.",
      },
    );
  }
  if (status === 429) {
    return new AppError("UPSTREAM_RATE_LIMIT", "Upstream rate limit reached", {
      hint: retryAfter ? `Retry after ${retryAfter} seconds` : "Retry later",
      retryable: true,
    });
  }
  if (status >= 500) {
    return new AppError("UPSTREAM_5XX", message, { retryable: true });
  }
  return new AppError("UPSTREAM_VALIDATION", message);
}

/** Best-effort short `message` from an error body ({ message, code, issues } on Dokploy). Never throws. */
async function upstreamMessage(
  response: Response,
): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (!text || text.trimStart().startsWith("<")) return undefined;
    const parsed: unknown = JSON.parse(text);
    const message =
      parsed && typeof parsed === "object" && "message" in parsed
        ? (parsed as { message?: unknown }).message
        : undefined;
    return typeof message === "string" && message
      ? message.replace(/\s+/g, " ").slice(0, 200)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function requestUpstream(
  options: RequestOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retries = options.retries ?? 3;
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const combinedSignal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;

    try {
      const url = new URL(
        options.path.replace(/^\/+/, ""),
        `${options.baseUrl.replace(/\/+$/, "")}/`,
      );
      options.validateUrl?.(url);
      if (url.origin !== new URL(options.baseUrl).origin) {
        throw new AppError(
          "UPSTREAM_UNREACHABLE",
          "Refusing an upstream redirect or cross-origin URL",
        );
      }

      const requestInit: RequestInit = {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...options.headers,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        redirect: "manual",
        signal: combinedSignal,
      };
      if (options.body !== undefined) {
        requestInit.body = JSON.stringify(options.body);
      }
      const response = await fetchImpl(url, requestInit);

      if (response.status >= 300 && response.status < 400) {
        throw new AppError(
          "UPSTREAM_UNREACHABLE",
          "Upstream redirects are not followed",
          {
            hint: "Use the final upstream HTTPS URL directly.",
          },
        );
      }

      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after") ?? undefined;
        const detail = await upstreamMessage(response);
        const appError = errorForStatus(
          response.status,
          detail
            ? `Upstream rejected the request: ${detail}`
            : "Upstream request failed",
          retryAfter,
        );
        if (appError.retryable && attempt < retries) {
          const seconds = retryAfter
            ? Number(retryAfter)
            : ([1, 3, 9][attempt] ?? 9);
          const fallbackDelay = [1, 3, 9][attempt] ?? 9;
          await sleep(
            Number.isFinite(seconds) ? seconds * 1000 : fallbackDelay * 1000,
          );
          attempt++;
          continue;
        }
        throw appError;
      }

      const text = await response.text();
      if (!text) return null;
      const contentType =
        response.headers.get("content-type")?.toLowerCase() ?? "";
      if (
        /^[\w.+-]{1,64}$/.test(text.trim()) &&
        !contentType.includes("json")
      ) {
        return text.trim(); // plain-text body, e.g. Coolify GET /version -> 4.7.5
      }
      if (
        contentType.includes("text/html") ||
        text.trimStart().startsWith("<")
      ) {
        throw new AppError(
          "UPSTREAM_VALIDATION",
          "Upstream returned HTML instead of JSON",
          {
            hint: "Check that the base URL includes the API host and not a login or reverse-proxy page.",
          },
        );
      }
      if (contentType.includes("text/plain")) return text;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new AppError(
          "UPSTREAM_VALIDATION",
          "Upstream returned invalid JSON",
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new AppError(
          "UPSTREAM_UNREACHABLE",
          "Upstream request timed out",
          {
            retryable: attempt < retries,
          },
        );
      }
      throw new AppError(
        "UPSTREAM_UNREACHABLE",
        "Could not reach the upstream",
        {
          retryable: attempt < retries,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
