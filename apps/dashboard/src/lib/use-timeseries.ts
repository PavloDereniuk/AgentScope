import { useQuery } from '@tanstack/react-query';
import { apiClient } from './api-client';

export type TimeseriesWindow = '24h' | '7d';
export type TimeseriesBucket = '1h' | '1d';
export type TimeseriesMetric = 'tx' | 'solDelta' | 'successRate';

export interface TimeseriesPoint {
  t: string;
  value: number | string | null;
}

export interface TimeseriesResponse {
  window: TimeseriesWindow;
  bucket: TimeseriesBucket;
  metric: TimeseriesMetric;
  agentId: string | null;
  points: TimeseriesPoint[];
}

interface UseTimeseriesOptions {
  window?: TimeseriesWindow;
  bucket?: TimeseriesBucket;
  metric?: TimeseriesMetric;
  /** Restrict the series to a single agent. When omitted, aggregates across the user's fleet. */
  agentId?: string;
  /** Skip the query entirely (e.g. before an agent id is known). */
  enabled?: boolean;
}

/**
 * Thin react-query wrapper around `GET /api/stats/timeseries`. Returns the
 * raw payload plus a pre-extracted numeric `sparkPoints` array — callers
 * just pipe that into the `Sparkline` component without worrying about
 * the numeric/string split the API uses to preserve lamport precision
 * on `solDelta`.
 *
 * null values (empty buckets for `successRate`) are dropped from
 * `sparkPoints` so the Sparkline draws a continuous line; the raw
 * `points` array stays available for callers that need gap awareness.
 */
export function useTimeseries(opts: UseTimeseriesOptions = {}) {
  const { window = '24h', bucket = '1h', metric = 'tx', agentId, enabled = true } = opts;

  const params = new URLSearchParams({ window, bucket, metric });
  if (agentId) params.set('agentId', agentId);
  const path = `/api/stats/timeseries?${params.toString()}`;

  const query = useQuery({
    queryKey: ['stats', 'timeseries', { window, bucket, metric, agentId: agentId ?? null }],
    queryFn: () => apiClient.get<TimeseriesResponse>(path),
    enabled,
    // A sparkline is a low-priority hint — refresh at the same cadence
    // as the other Overview KPIs and rely on SSE invalidation for faster
    // updates once 13.13/13.14 land.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const points = query.data?.points ?? [];
  const sparkPoints = points
    .map((p) => (typeof p.value === 'string' ? Number.parseFloat(p.value) : p.value))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  return { ...query, points, sparkPoints };
}
