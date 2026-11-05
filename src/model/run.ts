import { asArray, asNumber, asObject, asString, type Json, type JsonObject } from "./json.ts";

export const TRIVIAL_SECONDS = 30;
export const LOST_AFTER_SECONDS = 300;
const SPARK_POINTS = 32;

export type Status = "finished" | "crashed" | "killed" | "running" | "lost" | string;

/** The last value of each metric, metric names in first-seen order, and short series for curves. */
export interface MetricSummary {
  last: Record<string, Json>;
  keys: string[];
  sparks: Record<string, number[]>;
}

/**
 * One run folder, read back. Mirrors hunch's RunRecord (store.py), following the
 * on-disk format in hunch's docs/format.md.
 */
export class Run {
  readonly dir: string;
  readonly id: string;
  readonly meta: JsonObject;
  readonly end: JsonObject | undefined;
  readonly notes: JsonObject[];
  /** Seconds since the heartbeat file last changed, or undefined without one. */
  private readonly heartbeatAge: number | undefined;
  private readonly liveRows: JsonObject[];
  private summaryCache: MetricSummary | undefined;

  constructor(dir: string, id: string, meta: JsonObject, end: JsonObject | undefined, notes: JsonObject[], heartbeatAge: number | undefined, liveRows: JsonObject[]) {
    this.dir = dir;
    this.id = id;
    this.meta = meta;
    this.end = end;
    this.notes = notes;
    this.heartbeatAge = heartbeatAge;
    this.liveRows = liveRows;
  }

  /** The start time as written, for sorting. */
  get startedAt(): string {
    return asString(this.meta.started_at) ?? "";
  }

  get startedMs(): number {
    return Date.parse(this.startedAt);
  }

  get status(): Status {
    const recorded = asString(this.end?.status);
    if (recorded) return recorded;
    return (this.heartbeatAge ?? Infinity) < LOST_AFTER_SECONDS ? "running" : "lost";
  }

  get duration(): number | undefined {
    return asNumber(this.end?.duration);
  }

  get exitCode(): number | undefined {
    return asNumber(this.end?.exit_code);
  }

  /** A quick crash or stop, such as a typo. Quick runs that finished count. */
  get trivial(): boolean {
    return this.end !== undefined && this.status !== "finished" && (this.duration ?? 0) < TRIVIAL_SECONDS;
  }

  get why(): string | undefined {
    return this.latestNote("why", asString(this.meta.why)) ?? undefined;
  }

  get conclusion(): string | undefined {
    return this.latestNote("note", undefined) ?? undefined;
  }

  get verdict(): string | undefined {
    return this.latestNote("verdict", undefined) ?? undefined;
  }

  get parent(): string | undefined {
    return this.latestNote("parent", asString(this.meta.parent)) ?? undefined;
  }

  get line(): string | undefined {
    return asString(this.meta.line);
  }

  get command(): string[] {
    return asArray(this.meta.command).map(String);
  }

  get git(): JsonObject | undefined {
    const value = this.meta.git;
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  }

  get host(): JsonObject {
    return asObject(this.meta.host);
  }

  get finalMetrics(): Record<string, Json> {
    return this.summary().last;
  }

  get metricKeys(): string[] {
    return this.summary().keys;
  }

  spark(key: string): number[] {
    return this.summary().sparks[key] ?? [];
  }

  /** The project setting, then the run's own, then the first metric with "val", then the last one. */
  mainMetric(override: string | undefined): string | undefined {
    if (override) return override;
    const own = asString(this.meta.main_metric);
    if (own) return own;
    const keys = this.metricKeys;
    return keys.find((k) => k.toLowerCase().includes("val")) ?? keys[keys.length - 1];
  }

  private summary(): MetricSummary {
    if (!this.summaryCache) {
      if (this.end) {
        const sparks: Record<string, number[]> = {};
        for (const [key, values] of Object.entries(asObject(this.end.sparks))) {
          sparks[key] = asArray(values).filter((v): v is number => typeof v === "number");
        }
        this.summaryCache = {
          last: asObject(this.end.metrics),
          keys: asArray(this.end.metric_keys).map(String),
          sparks,
        };
      } else {
        this.summaryCache = summarize(this.liveRows);
      }
    }
    return this.summaryCache;
  }

  /** The latest annotation of a kind; `null` when it was explicitly cleared. */
  private latestNote<T>(kind: string, fallback: T): T | string | null {
    for (let i = this.notes.length - 1; i >= 0; i--) {
      if (this.notes[i].kind === kind) {
        const value = this.notes[i].value;
        return typeof value === "string" ? value : null;
      }
    }
    return fallback;
  }
}

/** The metric summary of a run still in progress, from its metrics.jsonl rows. */
export function summarize(rows: JsonObject[]): MetricSummary {
  const last: Record<string, Json> = {};
  const series: Record<string, number[]> = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith("_")) continue;
      last[key] = value;
      if (typeof value === "number") (series[key] ??= []).push(value);
    }
  }
  const sparks: Record<string, number[]> = {};
  for (const [key, values] of Object.entries(series)) sparks[key] = downsample(values, SPARK_POINTS);
  return { last, keys: Object.keys(last), sparks };
}

/** Averages values into at most `points` buckets, skipping NaN and infinity. */
export function downsample(values: number[], points: number): number[] {
  if (values.length <= points) return values;
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const chunk = values.slice(Math.floor((i * values.length) / points), Math.floor(((i + 1) * values.length) / points));
    const finite = chunk.filter(Number.isFinite);
    out.push(finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : chunk[chunk.length - 1]);
  }
  return out;
}
