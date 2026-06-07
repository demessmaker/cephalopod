// Minimal Prometheus-style metrics + a hook for structured request logging (Track E,
// ops). Dependency-free: an in-process counter set rendered as text/plain on /metrics.
// Histograms are intentionally omitted — counters + gauges cover the self-host need
// and a scraper can derive rates.
export class Metrics {
  private requests = 0;
  private byClass: Record<string, number> = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  private readonly startedAt = Date.now();

  // Record a finished response by its status code.
  record(status: number): void {
    this.requests++;
    const cls = status < 300 ? "2xx" : status < 400 ? "3xx" : status < 500 ? "4xx" : "5xx";
    this.byClass[cls] = (this.byClass[cls] ?? 0) + 1;
  }

  // Prometheus text exposition (v0.0.4).
  render(): string {
    const mem = process.memoryUsage();
    const uptime = Math.floor((Date.now() - this.startedAt) / 1000);
    const out: string[] = [
      "# HELP cephalopod_http_requests_total Total HTTP requests handled.",
      "# TYPE cephalopod_http_requests_total counter",
      `cephalopod_http_requests_total ${this.requests}`,
      "# HELP cephalopod_http_responses_total HTTP responses by status class.",
      "# TYPE cephalopod_http_responses_total counter",
      ...Object.entries(this.byClass).map(([k, v]) => `cephalopod_http_responses_total{class="${k}"} ${v}`),
      "# HELP cephalopod_uptime_seconds Process uptime in seconds.",
      "# TYPE cephalopod_uptime_seconds gauge",
      `cephalopod_uptime_seconds ${uptime}`,
      "# HELP cephalopod_resident_memory_bytes Resident set size in bytes.",
      "# TYPE cephalopod_resident_memory_bytes gauge",
      `cephalopod_resident_memory_bytes ${mem.rss}`,
    ];
    return out.join("\n") + "\n";
  }
}
