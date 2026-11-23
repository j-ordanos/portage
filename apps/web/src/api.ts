export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** Every call is same-origin; mutations carry the CSRF header the server requires. Secrets are never kept client-side. */
export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(method === "GET" ? {} : { "X-Requested-With": "migrator" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // plain-text responses (markdown report)
  }
  if (response.status === 401 && !path.startsWith("/auth/")) {
    window.dispatchEvent(new Event("portage:session-expired"));
  }
  if (!response.ok) {
    const payload = (data ?? {}) as {
      message?: string;
      code?: string;
      hint?: string;
    };
    throw new ApiError(
      response.status,
      payload.message ?? `Request failed (${response.status})`,
      payload.code,
      payload.hint,
    );
  }
  return data as T;
}

export const errorText = (
  error: unknown,
): { message: string; hint?: string } =>
  error instanceof ApiError
    ? { message: error.message, ...(error.hint ? { hint: error.hint } : {}) }
    : {
        message:
          error instanceof Error ? error.message : "Something went wrong",
      };
