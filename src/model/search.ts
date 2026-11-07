import * as path from "node:path";
import { command, flatten, value } from "./format.ts";
import { asObject, asString } from "./json.ts";
import type { Run } from "./run.ts";
import { readJson } from "./store.ts";

const SEARCHED_NOTES = new Set(["why", "note", "verdict"]);

/** What a search looks through in each run, read once per run (a reload makes new runs). */
const texts = new WeakMap<Run, string>();

/** The words of a search; a run matches when it has every one of them. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Whether the run has every word somewhere in its id, hypotheses (old ones too), conclusions,
 * verdict, status, command or config, ignoring case.
 */
export function matches(run: Run, words: string[], root: string): boolean {
  let text = texts.get(run);
  if (text === undefined) {
    const config = flatten(asObject(asObject(readJson(path.join(run.dir, "config.json"))).values));
    text = [
      run.id,
      asString(run.meta.why),
      ...run.notes.filter((event) => SEARCHED_NOTES.has(String(event.kind))).map((event) => asString(event.value)),
      command(run, root),
      ...Object.entries(config).map(([key, v]) => `${key} = ${value(v)}`),
    ].filter(Boolean).join("\n").toLowerCase();
    texts.set(run, text);
  }
  const all = `${text}\n${run.status}`; // the status can change without a reload: a quiet heartbeat turns running into lost
  return words.every((word) => all.includes(word));
}
