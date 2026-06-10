import { resolveApiUrl } from './api-url';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type TokenGetter = () => Promise<string | null>;

let getToken: TokenGetter = async () => null;

export function setTokenGetter(fn: TokenGetter) {
  getToken = fn;
}

/** Get the current Privy access token. Used by non-fetch transports (e.g. EventSource). */
export function getAccessToken(): Promise<string | null> {
  return getToken();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const token = await getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(resolveApiUrl(path), { ...init, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('Request timed out — the server may be starting up, please try again.');
    }
    throw err;
  }

  if (res.status === 204) {
    return undefined as T;
  }

  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      res.status,
      json?.error?.code ?? 'UNKNOWN',
      json?.error?.message ?? res.statusText,
    );
  }

  return res.json() as Promise<T>;
}

export const apiClient = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: (path: string) => request<void>('DELETE', path),
};
