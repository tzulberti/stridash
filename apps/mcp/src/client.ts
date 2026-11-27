/** Thin authenticated client for the Stridash REST API. */

export interface StridashMcpConfig {
  apiUrl: string;
  token: string;
}

export class StridashApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'StridashApiError';
    this.status = status;
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): StridashMcpConfig {
  const apiUrl = env.STRIDASH_API_URL?.trim().replace(/\/$/, '');
  const token = env.STRIDASH_API_TOKEN?.trim();
  if (!apiUrl) throw new Error('STRIDASH_API_URL is required (e.g. http://localhost:3000)');
  if (!token) throw new Error('STRIDASH_API_TOKEN is required (create one at POST /api/tokens)');
  return { apiUrl, token };
}

type Query = Record<string, string | number | undefined>;

async function get<T>(config: StridashMcpConfig, path: string, query?: Query): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) q.set(k, String(v));
  const url = `${config.apiUrl}/api${path}${q.size ? `?${q.toString()}` : ''}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `Stridash API unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // leave null; the HTTP status carries the failure
  }
  if (!res.ok) {
    const detail =
      json && typeof json === 'object' && 'error' in json
        ? String((json as { error?: unknown }).error)
        : `request failed (HTTP ${res.status})`;
    throw new StridashApiError(detail, res.status);
  }
  return json as T;
}

export interface ListQuery {
  from?: string;
  to?: string;
  limit?: number;
}

export function createStridashClient(config: StridashMcpConfig) {
  const list = (path: string, query: ListQuery = {}) =>
    get<{ items: unknown[]; nextCursor: string | null }>(config, path, {
      limit: query.limit,
      from: query.from,
      to: query.to,
    });

  return {
    searchActivities: (query?: ListQuery) => list('/activities', query),
    getActivity: (id: string) => get<{ items: unknown[] }>(config, `/activities/${id}`),
    getSimilarActivities: (id: string) => list(`/activities/${id}/similar`),
    getMeasurements: (query?: ListQuery) => list('/measurements', query),
    getSleeps: (query?: ListQuery) => list('/sleeps', query),
    getWellness: (query?: ListQuery) => list('/wellness', query),
    getGear: () => list('/gear'),
    getConnections: () => list('/connections'),
  };
}

export type StridashClient = ReturnType<typeof createStridashClient>;
