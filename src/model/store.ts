import * as fs from "node:fs";
import * as path from "node:path";
import { asArray, asObject, asString, parse, write, type Json, type JsonObject } from "./json.ts";
import { Run } from "./run.ts";

/** A milestone folder, read back. See "Milestones" in hunch's docs/format.md. */
export class Milestone {
  readonly dir: string;
  readonly id: string;
  readonly meta: JsonObject;

  constructor(dir: string, meta: JsonObject) {
    this.dir = dir;
    this.id = path.basename(dir);
    this.meta = meta;
  }

  get createdAt(): string {
    return asString(this.meta.created_at) ?? "";
  }

  get title(): string {
    return asString(this.meta.title) ?? "";
  }

  get description(): string | undefined {
    const text = asString(this.meta.description);
    return text && text.trim() ? text : undefined;
  }

  get summary(): string {
    return asString(this.meta.summary) ?? "";
  }

  get runs(): string[] {
    return asArray(this.meta.runs).map(String);
  }

  get best(): string | undefined {
    return asString(this.meta.best);
  }

  get metric(): string | undefined {
    return asString(this.meta.metric);
  }

  get line(): string | undefined {
    return asString(this.meta.line);
  }
}

/** A project's .hunch folder, read the way hunch itself reads it. Reads never write. */
export class Store {
  readonly root: string;
  readonly dir: string;
  readonly runsDir: string;
  readonly objects: string;
  readonly milestonesDir: string;

  constructor(root: string) {
    this.root = root;
    this.dir = path.join(root, ".hunch");
    this.runsDir = path.join(this.dir, "runs");
    this.objects = path.join(this.dir, "objects");
    this.milestonesDir = path.join(this.dir, "milestones");
  }

  /** The nearest folder with .hunch/runs from `start` up to the git root, otherwise `start` itself. */
  static find(start: string): Store {
    let folder = path.resolve(start);
    for (;;) {
      if (isDirectory(path.join(folder, ".hunch", "runs"))) return new Store(folder);
      if (fs.existsSync(path.join(folder, ".git"))) break;
      const parent = path.dirname(folder);
      if (parent === folder) break;
      folder = parent;
    }
    return new Store(path.resolve(start));
  }

  exists(): boolean {
    return isDirectory(this.runsDir);
  }

  config(): JsonObject {
    return asObject(readJson(path.join(this.dir, "config.json")));
  }

  mainMetric(): string | undefined {
    return asString(this.config().main_metric) || undefined;
  }

  /** All runs, oldest first. Folders that are not runs (yet) are skipped. */
  runs(now = Date.now()): Run[] {
    const runs = listDirectories(this.runsDir).map((folder) => loadRun(folder, now)).filter((run): run is Run => run !== undefined);
    return runs.sort((a, b) => a.startedMs - b.startedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** All milestones, oldest first, so M1 is the first. */
  milestones(): Milestone[] {
    const loaded: Milestone[] = [];
    for (const folder of listDirectories(this.milestonesDir)) {
      const meta = readJson(path.join(folder, "milestone.json"));
      if (meta && typeof meta === "object" && !Array.isArray(meta) && typeof meta.created_at === "string") {
        loaded.push(new Milestone(folder, meta));
      }
    }
    return loaded.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1));
  }

  /**
   * Changes whenever a run starts, ends, gets a note, logs a metric, or a milestone is saved.
   * Cheap: directory listings and a few file sizes per run. Includes the minute, because
   * whether a run without an end is still running depends on the clock.
   */
  signature(now = Date.now()): string {
    const parts: string[] = [];
    for (const folder of listDirectories(this.runsDir)) {
      parts.push(path.basename(folder));
      for (const name of ["run.json", "end.json", "notes.jsonl", "metrics.jsonl"]) parts.push(String(fileSize(path.join(folder, name))));
    }
    for (const folder of listDirectories(this.milestonesDir)) {
      if (fs.existsSync(path.join(folder, "milestone.json"))) parts.push(path.basename(folder));
    }
    parts.push(String(fileSize(path.join(this.dir, "config.json"))), String(Math.floor(now / 60_000)));
    return parts.join("|");
  }

  /** Appends an annotation, exactly as `hunch note` and `hunch link` do. */
  annotate(run: Run, kind: "why" | "note" | "verdict" | "parent", value: string | null): void {
    const event = { at: timestamp(), kind, value };
    fs.appendFileSync(path.join(run.dir, "notes.jsonl"), write(event) + "\n", "utf8");
  }
}

function loadRun(folder: string, now: number): Run | undefined {
  const meta = readJson(path.join(folder, "run.json"));
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || typeof meta.started_at !== "string") return undefined;
  if (Number.isNaN(Date.parse(meta.started_at))) return undefined;
  const endValue = readJson(path.join(folder, "end.json"));
  const end = endValue && typeof endValue === "object" && !Array.isArray(endValue) ? endValue : undefined;
  let heartbeatAge: number | undefined;
  try {
    heartbeatAge = (now - fs.statSync(path.join(folder, "heartbeat")).mtimeMs) / 1000;
  } catch {
    heartbeatAge = undefined;
  }
  const liveRows = end ? [] : readJsonLines(path.join(folder, "metrics.jsonl"));
  return new Run(folder, path.basename(folder), meta, end, readJsonLines(path.join(folder, "notes.jsonl")), heartbeatAge, liveRows);
}

export function readJson(file: string): Json | undefined {
  try {
    return parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** One object per line. A last line cut short by a crash is skipped. */
export function readJsonLines(file: string): JsonObject[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows: JsonObject[] = [];
  // Split on \n only: values may contain U+2028 and other line separators.
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) rows.push(value);
    } catch {
      // a line still being written
    }
  }
  return rows;
}

/** An ISO 8601 time with milliseconds and the local offset, like Python's isoformat(). */
export function timestamp(date = new Date()): string {
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function listDirectories(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name)).sort();
  } catch {
    return [];
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}
