export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Validation details as readable lines (400 responses list one issue per entry). */
  get detailLines(): string[] {
    if (!Array.isArray(this.details)) return [];
    return this.details.map((d) =>
      typeof d === 'string' ? d : d && typeof d === 'object' && 'message' in d ? `${(d as { path?: string }).path ? `${(d as { path: string }).path}: ` : ''}${(d as { message: string }).message}` : JSON.stringify(d),
    );
  }
}

/** Fired when the server says the session is gone, so the app can return to the profile gate. */
export const UNAUTHORIZED_EVENT = 'streamora:unauthorized';

async function request<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: string; message?: string; details?: unknown } | null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/profiles')) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, data?.error, data?.message ?? res.statusText, data?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string, init?: RequestInit) => request<T>('GET', url, undefined, init),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return [err.message, ...err.detailLines].join('\n');
  return err instanceof Error ? err.message : String(err);
}

export const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};
