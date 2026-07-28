import { describe, expect, it } from "vitest";
import {
  HttpLatencyTracker,
  normalizeHttpRouteKey,
} from "../../src/transports/http/httpLatencyTracker.js";

describe("HttpLatencyTracker", () => {
  it("normalizeHttpRouteKey collapses UUID thread ids to :id", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(
      normalizeHttpRouteKey("GET", `/api/threads/${uuid}/messages`),
    ).toBe("GET /api/threads/:id/messages");
    expect(
      normalizeHttpRouteKey("POST", `/api/threads/${uuid}/messages`),
    ).toBe("POST /api/threads/:id/messages");
  });

  it("normalizeHttpRouteKey prefers route template when provided", () => {
    expect(
      normalizeHttpRouteKey(
        "GET",
        "/api/threads/550e8400-e29b-41d4-a716-446655440000",
        "/api/threads/:threadId",
      ),
    ).toBe("GET /api/threads/:threadId");
  });

  it("percentiles on 1..10 yield p50=5 and p95=10", () => {
    const tracker = new HttpLatencyTracker({ maxSamples: 20 });
    for (let value = 1; value <= 10; value += 1) {
      tracker.record("GET", "/health", value);
    }

    const snapshot = tracker.snapshot();
    const health = snapshot.endpoints["GET /health"];
    expect(health.count).toBe(10);
    expect(health.p50_ms).toBe(5);
    expect(health.p95_ms).toBe(10);
    expect(health.p99_ms).toBe(10);
  });

  it("window expiry drops old samples", () => {
    const tracker = new HttpLatencyTracker({ windowMs: 1000, maxSamples: 10 });
    const now = Date.now();
    tracker.record("GET", "/health", 5);
    (tracker as any).routes.get("GET /health").samples[0].timestampMs = now - 2000;

    const snapshot = tracker.snapshot();
    expect(snapshot.endpoints["GET /health"]).toBeUndefined();
  });

  it("excluded prefixes are skipped", () => {
    const tracker = new HttpLatencyTracker();
    tracker.record("GET", "/static/app.js", 12);
    tracker.record("GET", "/favicon.ico", 8);

    const snapshot = tracker.snapshot();
    expect(snapshot.endpoints).toEqual({});
  });

  it("maxRoutes LRU eviction keeps newest routes", () => {
    const tracker = new HttpLatencyTracker({ maxRoutes: 2, maxSamples: 4 });
    tracker.record("GET", "/route-a", 1);
    tracker.record("GET", "/route-b", 2);
    tracker.record("GET", "/route-c", 3);

    const snapshot = tracker.snapshot();
    expect(snapshot.endpoints["GET /route-a"]).toBeUndefined();
    expect(snapshot.endpoints["GET /route-b"]).toBeDefined();
    expect(snapshot.endpoints["GET /route-c"]).toBeDefined();
  });

  it("reset clears tracked state", () => {
    const tracker = new HttpLatencyTracker();
    tracker.record("GET", "/health", 4);
    expect(tracker.snapshot().endpoints["GET /health"]).toBeDefined();

    tracker.reset();
    expect(tracker.snapshot().endpoints).toEqual({});
  });
});
