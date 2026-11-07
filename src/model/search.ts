import * as path from "node:path";
import { command, flatten, value } from "./format.ts";
import { asObject, asString } from "./json.ts";
import type { Run } from "./run.ts";
import { readJson } from "./store.ts";

/**
 * Searching the run table. A word is found anywhere in a run's id, hypotheses (earlier ones too),
 * conclusions, verdict, status, command or config, ignoring case. Filters narrow it down:
 *
 *   is:running, is:finished, is:crashed, is:stopped, is:lost   how it ended, or that it has not
 *   is:kept, is:dropped, is:unreviewed                          its verdict; unreviewed: ended, with none and no conclusion
 *   is:remote                                                    run on another machine by Ferry
 *   since:12h, since:7d, since:2w, since:today, since:2026-11-01 when it started
 *   from:a7f3                                                    that run and every run that came from it
 *   on:gpu-box, branch:main                                      where it ran, the git branch it started on
 *   val_loss<0.3, lr=3e-4, optimizer=adam                        a final metric or config value: <, <=, >, >=, =
 *
 * A run must match every word and filter. A leading - turns one around (-is:dropped), and commas
 * mean either (is:crashed,stopped).
 */

/** The filters the filter menu offers; anything else is typed. */
export const FILTER_MENU = [
  { filter: "is:unreviewed", label: "Not reviewed yet", detail: "Ended, with no verdict or conclusion" },
  { filter: "is:kept", label: "Kept" },
  { filter: "-is:dropped", label: "Without dropped runs" },
  { filter: "is:running", label: "Running" },
  { filter: "is:crashed,stopped", label: "Crashed or stopped" },
  { filter: "is:remote", label: "Ran on another machine", detail: "Copied home by Ferry" },
  { filter: "since:1d", label: "Started in the last 24 hours" },
  { filter: "since:7d", label: "Started in the last 7 days" },
] as const;

export const FILTER_HELP = "Filters: is:unreviewed, is:kept, since:7d, val_loss<0.3, lr=3e-4, from:a7f3, -is:dropped";

type Test = (run: Run) => boolean;

const IS: Record<string, Test> = {
  running: (run) => run.status === "running",
  finished: (run) => run.status === "finished",
  crashed: (run) => run.status === "crashed",
  stopped: (run) => run.status === "killed",
  killed: (run) => run.status === "killed",
  lost: (run) => run.status === "lost",
  kept: (run) => run.verdict === "keep",
  dropped: (run) => run.verdict === "drop",
  unreviewed: (run) => run.end !== undefined && !run.trivial && !run.verdict && !run.conclusion,
  remote: (run) => run.remote !== undefined,
};

const QUALIFIER = /^(is|since|from|on|branch):(.+)$/i;
const COMPARISON = /^([A-Za-z_][\w./-]*)(<=|>=|<|>|=)(.+)$/;
const HOUR = 3600_000;
const AGO: Record<string, number> = { h: HOUR, d: 24 * HOUR, w: 7 * 24 * HOUR };
const SEARCHED_NOTES = new Set(["why", "note", "verdict"]);

/** The runs that match a search: every word and filter in it. */
export function search(runs: Run[], query: string, root: string, now = Date.now()): Run[] {
  const tests = query.split(/\s+/).filter(Boolean).map((token) => {
    const negate = token.length > 1 && token.startsWith("-");
    const body = negate ? token.slice(1) : token;
    const test = filter(body, runs, root, now) ?? ((run: Run) => `${read(run, root).text}\n${run.status}`.includes(body.toLowerCase()));
    return (run: Run) => test(run) !== negate;
  });
  return runs.filter((run) => tests.every((test) => test(run)));
}

/** Whether the search has this filter, exactly as the menu writes it. */
export function hasFilter(query: string, filter: string): boolean {
  return query.split(/\s+/).includes(filter);
}

/** The search with a filter added or taken out, leaving the rest as typed. */
export function withFilter(query: string, filter: string, on: boolean): string {
  const tokens = query.split(/\s+/).filter((token) => token && token !== filter);
  return (on ? [...tokens, filter] : tokens).join(" ");
}

/** A filter's test, or nothing when the token is a plain word (including filters that do not parse). */
function filter(body: string, runs: Run[], root: string, now: number): Test | undefined {
  const qualifier = QUALIFIER.exec(body);
  if (qualifier) {
    const values = qualifier[2].toLowerCase().split(",").filter(Boolean);
    switch (qualifier[1].toLowerCase()) {
      case "is": {
        const tests = values.map((v) => IS[v]);
        return tests.length && tests.every(Boolean) ? (run) => tests.some((test) => test(run)) : undefined;
      }
      case "since": {
        const cutoff = since(values[0] ?? "", now);
        return cutoff === undefined ? undefined : (run) => run.startedMs >= cutoff;
      }
      case "from": {
        const family = descendants(runs, values);
        return (run) => family.has(run.id);
      }
      case "on":
        return (run) => values.some((v) => [run.remote?.machine, asString(run.host.hostname)].some((name) => name?.toLowerCase().includes(v)));
      case "branch":
        return (run) => values.some((v) => (run.line ?? "").toLowerCase().includes(v));
    }
  }
  const comparison = COMPARISON.exec(body);
  return comparison ? compare(comparison[1], comparison[2], comparison[3], root) : undefined;
}

function since(text: string, now: number): number | undefined {
  const ago = /^(\d+)([hdw])$/.exec(text);
  if (ago) return now - Number(ago[1]) * AGO[ago[2]];
  const today = new Date(now);
  if (text === "today") return new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return date ? new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime() : undefined;
}

/** The runs named (by the end of their id) and every run that came from them. */
function descendants(runs: Run[], refs: string[]): Set<string> {
  const family = new Set(runs.filter((run) => refs.some((ref) => run.id.toLowerCase().endsWith(ref))).map((run) => run.id));
  for (let grew = family.size > 0; grew;) {
    grew = false;
    for (const run of runs) {
      if (!family.has(run.id) && run.parent && family.has(run.parent)) {
        family.add(run.id);
        grew = true;
      }
    }
  }
  return family;
}

/** A metric (its final value) or config value against a number, or = against what the table shows. */
function compare(name: string, op: string, wanted: string, root: string): Test {
  const number = Number(wanted);
  const numeric = wanted.trim() !== "" && Number.isFinite(number);
  return (run) => {
    const actual = lookup(run, name, root);
    if (actual === undefined) return false;
    if (op === "=") return typeof actual === "number" && numeric ? value(actual) === value(number) : value(actual).toLowerCase() === wanted.toLowerCase();
    if (typeof actual !== "number" || !numeric) return false;
    return op === "<" ? actual < number : op === "<=" ? actual <= number : op === ">" ? actual > number : actual >= number;
  };
}

function lookup(run: Run, name: string, root: string): unknown {
  for (const values of [run.finalMetrics as Record<string, unknown>, read(run, root).config]) {
    if (name in values) return values[name];
    const key = Object.keys(values).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key !== undefined) return values[key];
  }
  return undefined;
}

/** What a search looks through in each run, read once per run (a reload makes new runs). */
const cache = new WeakMap<Run, { text: string; config: Record<string, unknown> }>();

function read(run: Run, root: string): { text: string; config: Record<string, unknown> } {
  let found = cache.get(run);
  if (found === undefined) {
    const config = flatten(asObject(asObject(readJson(path.join(run.dir, "config.json"))).values));
    const text = [
      run.id,
      asString(run.meta.why),
      ...run.notes.filter((event) => SEARCHED_NOTES.has(String(event.kind))).map((event) => asString(event.value)),
      command(run, root),
      ...Object.entries(config).map(([key, v]) => `${key} = ${value(v)}`),
    ].filter(Boolean).join("\n").toLowerCase();
    found = { text, config };
    cache.set(run, found);
  }
  return found;
}
