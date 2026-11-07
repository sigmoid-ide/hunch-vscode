import * as path from "node:path";
import type { Run } from "./run.ts";

/** Text formatting shared with the `hunch` command line, so both read the same. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The shortest unique ending of each id: 4 characters, then longer. */
export function shortIds(ids: string[]): Map<string, string> {
  const lengths = [4, 6, 11];
  const counts = new Map(lengths.map((n) => {
    const count = new Map<string, number>();
    for (const id of ids) count.set(id.slice(-n), (count.get(id.slice(-n)) ?? 0) + 1);
    return [n, count] as const;
  }));
  return new Map(ids.map((id) => {
    const n = lengths.find((length) => counts.get(length)!.get(id.slice(-length)) === 1);
    return [id, n ? id.slice(-n) : id];
  }));
}

/**
 * Like hunch's format_value: floats as Python's f"{value:.4g}", everything else as text.
 * JSON numbers lose the int/float difference here, so whole numbers print as integers, and an exact
 * tie such as 1234.5 rounds up where Python rounds to even.
 */
export function value(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v !== "number") return String(v);
  if (Number.isNaN(v)) return "nan";
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return String(v);
  const [mantissa, exponentText] = v.toExponential(3).split("e");
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 4) {
    return `${stripZeros(mantissa)}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return stripZeros(v.toFixed(3 - exponent));
}

function stripZeros(text: string): string {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

export function duration(seconds: number | undefined): string {
  if (seconds === undefined) return "?";
  let s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  let m = Math.floor(s / 60);
  s %= 60;
  if (m < 60) return `${m}m ${s}s`;
  let h = Math.floor(m / 60);
  m %= 60;
  if (h < 48) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  h %= 24;
  return `${d}d ${h}h`;
}

/** "Nov 3 22:00": the wall-clock time where the run started, as written in the file. */
export function started(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])} ${match[4]}:${match[5]}`;
}

/** `python train.py --lr 3e-4` instead of the interpreter's full path and absolute script paths. */
export function command(run: { command: string[] }, root: string): string {
  return run.command.map((part, index) => {
    if (!path.isAbsolute(part)) return part;
    if (index === 0) return path.basename(part).replace(/\.exe$/i, "");
    const relative = path.relative(root, part);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : part;
  }).join(" ");
}

/** What the metric column shows for a run: its main metric's value, or how it ended. */
export function result(run: Run, key: string | undefined, now = Date.now()): string {
  const metric = key !== undefined && key in run.finalMetrics ? value(run.finalMetrics[key]) : "";
  switch (run.status) {
    case "finished": return metric;
    case "crashed": return run.exitCode !== undefined ? `crashed, exit ${run.exitCode}` : "crashed";
    case "killed": return "stopped";
    case "running": return `running ${duration((now - run.startedMs) / 1000)}${run.remote ? ` on ${run.remote.machine}` : ""}`;
    default: return run.status;
  }
}

/** Nested config as dotted keys, like hunch's flatten. */
export function flatten(values: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(values)) {
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) Object.assign(out, flatten(v as Record<string, unknown>, `${prefix}${key}.`));
    else out[`${prefix}${key}`] = v;
  }
  return out;
}
