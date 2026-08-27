export interface CongestionSample {
  latencyMs: number;
  success: boolean;
  confirmationMs?: number;
  timestamp?: number;
}

export interface CongestionMonitorOptions {
  windowSize?: number;
  healthyLatencyMs?: number;
  congestedLatencyMs?: number;
  healthyFailureRate?: number;
  congestedFailureRate?: number;
  minConcurrency?: number;
  maxConcurrency?: number;
}

export type CongestionLevel = "healthy" | "elevated" | "congested";

export interface CongestionSnapshot {
  level: CongestionLevel;
  sampleCount: number;
  averageLatencyMs: number;
  failureRate: number;
  averageConfirmationMs: number | null;
  recommendedConcurrency: number;
  recommendedDelayMs: number;
}

export class CongestionMonitor {
  private readonly samples: CongestionSample[] = [];
  private readonly options: Required<CongestionMonitorOptions>;

  constructor(options: CongestionMonitorOptions = {}) {
    this.options = {
      windowSize: Math.max(1, options.windowSize ?? 50),
      healthyLatencyMs: options.healthyLatencyMs ?? 500,
      congestedLatencyMs: options.congestedLatencyMs ?? 2000,
      healthyFailureRate: options.healthyFailureRate ?? 0.05,
      congestedFailureRate: options.congestedFailureRate ?? 0.25,
      minConcurrency: Math.max(1, options.minConcurrency ?? 1),
      maxConcurrency: Math.max(1, options.maxConcurrency ?? 8),
    };
    if (this.options.maxConcurrency < this.options.minConcurrency) {
      throw new Error("maxConcurrency must be greater than or equal to minConcurrency");
    }
  }

  record(sample: CongestionSample): CongestionSnapshot {
    if (!Number.isFinite(sample.latencyMs) || sample.latencyMs < 0) throw new Error("latencyMs must be a non-negative finite number");
    if (sample.confirmationMs !== undefined && (!Number.isFinite(sample.confirmationMs) || sample.confirmationMs < 0)) throw new Error("confirmationMs must be a non-negative finite number");
    this.samples.push({ ...sample, timestamp: sample.timestamp ?? Date.now() });
    if (this.samples.length > this.options.windowSize) this.samples.splice(0, this.samples.length - this.options.windowSize);
    return this.snapshot();
  }

  snapshot(): CongestionSnapshot {
    const sampleCount = this.samples.length;
    const averageLatencyMs = sampleCount ? this.samples.reduce((sum, sample) => sum + sample.latencyMs, 0) / sampleCount : 0;
    const failures = this.samples.filter((sample) => !sample.success).length;
    const confirmations = this.samples.filter((sample) => sample.confirmationMs !== undefined).map((sample) => sample.confirmationMs as number);
    const averageConfirmationMs = confirmations.length ? confirmations.reduce((sum, value) => sum + value, 0) / confirmations.length : null;
    const failureRate = sampleCount ? failures / sampleCount : 0;
    const level = averageLatencyMs >= this.options.congestedLatencyMs || failureRate >= this.options.congestedFailureRate ? "congested" : averageLatencyMs > this.options.healthyLatencyMs || failureRate > this.options.healthyFailureRate ? "elevated" : "healthy";
    const recommendedConcurrency = level === "healthy" ? this.options.maxConcurrency : level === "elevated" ? Math.max(this.options.minConcurrency, Math.ceil(this.options.maxConcurrency / 2)) : this.options.minConcurrency;
    const recommendedDelayMs = level === "healthy" ? 0 : level === "elevated" ? 250 : 1000;
    return { level, sampleCount, averageLatencyMs, failureRate, averageConfirmationMs, recommendedConcurrency, recommendedDelayMs };
  }

  reset(): void {
    this.samples.length = 0;
  }
}

export function createCongestionMonitor(options?: CongestionMonitorOptions): CongestionMonitor {
  return new CongestionMonitor(options);
}
