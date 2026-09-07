/** Thin fetch wrapper. Auth travels in httpOnly cookies set by the API. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type Body = Record<string, unknown> | FormData | undefined;

async function request<T>(method: string, path: string, body?: Body, signal?: AbortSignal): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: isForm || body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const payload: unknown = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const body = payload as { error?: { code?: string; message?: string } };
    const error = body.error ?? {};
    throw new ApiError(res.status, error.message ?? `Request failed (${res.status})`, error.code);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post: <T>(path: string, body?: Body) => request<T>('POST', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
