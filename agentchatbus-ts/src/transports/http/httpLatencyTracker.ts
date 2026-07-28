export const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_ROUTES = 64;
export const DEFAULT_MAX_SAMPLES_PER_ROUTE = 256;
export const EXCLUDED_PREFIXES = ["/static/", "/favicon.ico"];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_PATTERN = /^[0-9a-f]{16,}$/i;

export type HttpLatencyEndpointStats = {
  count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
};

export type HttpLatencySnapshot = {
  window_seconds: number;
  enabled: boolean;
  endpoints: Record<string, HttpLatencyEndpointStats>;
};

type LatencySample = {
  timestampMs: number;
  durationMs: number;
};

type RouteBucket = {
  samples: LatencySample[];
  lastUsedMs: number;
};

export type HttpLatencyTrackerOptions = {
  windowMs?: number;
  maxRoutes?: number;
  maxSamples?: number;
  enabled?: boolean;
};

function normalizePathSegment(segment: string): string {
  if (UUID_PATTERN.test(segment) || LONG_HEX_PATTERN.test(segment)) {
    return ":id";
  }
  return segment;
}

function normalizePathFromUrl(url: string): string {
  const pathOnly = url.split("?")[0].split("#")[0];
  if (!pathOnly || pathOnly === "/") {
    return "/";
  }
  const segments = pathOnly.split("/").filter(Boolean);
  const normalized = segments.map(normalizePathSegment).join("/");
  return `/${normalized}`;
}

export function normalizeHttpRouteKey(
  method: string,
  url: string,
  routeTemplate?: string,
): string {
  const normalizedMethod = method.toUpperCase();
  const path = routeTemplate
    ? routeTemplate.split("?")[0]
    : normalizePathFromUrl(url);
  return `${normalizedMethod} ${path}`;
}

function nearestRankPercentile(sortedValues: number[], percentile: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const rank = Math.ceil(percentile * sortedValues.length);
  const index = Math.max(0, Math.min(sortedValues.length - 1, rank - 1));
  return Math.round(sortedValues[index] * 10) / 10;
}

function buildEndpointStats(samples: LatencySample[]): HttpLatencyEndpointStats {
  if (samples.length === 0) {
    return {
      count: 0,
      p50_ms: null,
      p95_ms: null,
      p99_ms: null,
    };
  }

  const sorted = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50_ms: nearestRankPercentile(sorted, 0.5),
    p95_ms: nearestRankPercentile(sorted, 0.95),
    p99_ms: nearestRankPercentile(sorted, 0.99),
  };
}

export class HttpLatencyTracker {
  private readonly windowMs: number;
  private readonly maxRoutes: number;
  private readonly maxSamples: number;
  private readonly enabled: boolean;
  private readonly routes = new Map<string, RouteBucket>();

  constructor(options?: HttpLatencyTrackerOptions) {
    this.windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxRoutes = options?.maxRoutes ?? DEFAULT_MAX_ROUTES;
    this.maxSamples = options?.maxSamples ?? DEFAULT_MAX_SAMPLES_PER_ROUTE;
    this.enabled = options?.enabled ?? true;
  }

  record(method: string, url: string, durationMs: number, routeTemplate?: string): void {
    if (!this.enabled) {
      return;
    }

    const pathOnly = url.split("?")[0].split("#")[0];
    if (EXCLUDED_PREFIXES.some((prefix) => pathOnly === prefix || pathOnly.startsWith(prefix))) {
      return;
    }

    const routeKey = normalizeHttpRouteKey(method, url, routeTemplate);
    const now = Date.now();
    let bucket = this.routes.get(routeKey);
    if (!bucket) {
      this.evictIfNeeded(routeKey, now);
      bucket = { samples: [], lastUsedMs: now };
      this.routes.set(routeKey, bucket);
    }

    bucket.lastUsedMs = now;
    bucket.samples.push({ timestampMs: now, durationMs });
    this.pruneBucket(bucket, now);
    while (bucket.samples.length > this.maxSamples) {
      bucket.samples.shift();
    }
  }

  snapshot(): HttpLatencySnapshot {
    const now = Date.now();
    const endpoints: Record<string, HttpLatencyEndpointStats> = {};

    for (const [routeKey, bucket] of this.routes.entries()) {
      this.pruneBucket(bucket, now);
      if (bucket.samples.length === 0) {
        continue;
      }
      endpoints[routeKey] = buildEndpointStats(bucket.samples);
    }

    return {
      window_seconds: Math.round(this.windowMs / 1000),
      enabled: this.enabled,
      endpoints,
    };
  }

  reset(): void {
    this.routes.clear();
  }

  private pruneBucket(bucket: RouteBucket, now: number): void {
    const cutoff = now - this.windowMs;
    bucket.samples = bucket.samples.filter((sample) => sample.timestampMs >= cutoff);
  }

  private evictIfNeeded(routeKey: string, now: number): void {
    if (this.routes.has(routeKey) || this.routes.size < this.maxRoutes) {
      return;
    }

    let oldestKey: string | null = null;
    let oldestUsedMs = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.routes.entries()) {
      if (bucket.lastUsedMs < oldestUsedMs) {
        oldestUsedMs = bucket.lastUsedMs;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.routes.delete(oldestKey);
    }
  }
}
