// What the Runs view draws, as plain data: built here from the model and posted to the webview.
import * as path from "node:path";
import * as fmt from "./model/format.ts";
import { rows as layout, visible, width as rowWidth, type Row } from "./model/graph.ts";
import { asArray, asObject, asString } from "./model/json.ts";
import type { Run } from "./model/run.ts";
import { runsIn, type Scope } from "./model/scope.ts";
import { matches, searchWords } from "./model/search.ts";
import { files } from "./model/snapshot.ts";
import { readJson, type Milestone, type Store } from "./model/store.ts";

export interface RowView {
  id: string;
  short: string;
  started: string;
  why: string | null;
  metric: string;
  /** The metric's name when it differs from the column's. */
  metricKey: string | null;
  status: string;
  spark: number[];
  verdict: string | null;
  conclusion: string | null;
  lane: number;
  above: number;
  joining: number[];
  hasParent: boolean;
  node: "keep" | "drop" | "crashed" | "running" | "lost" | "plain";
}

export type DetailValue = { text: string } | { link: string; command: string; args: unknown[] };

export interface DetailsView {
  title: string;
  dimTitle: boolean;
  subtitle: string;
  rows: { label: string; value: DetailValue }[];
  actions: { label: string; command: string; args: unknown[] }[];
}

export interface ScreenView {
  loaded: boolean;
  headerMetric: string;
  graphWidth: number;
  rows: RowView[];
  selection: string[];
  /** Lines shown when the table is empty; the first one is the heading. */
  empty: string[];
  quickRuns: { count: number; showing: boolean };
  details: DetailsView | null;
  message: string | null;
  /** The search the table is showing, so the search box can follow a change made elsewhere. */
  search: string;
}

export interface Inputs {
  store: Store;
  runs: Run[];
  milestones: Milestone[];
  scope: Scope;
  mainMetric: string | undefined;
  loaded: boolean;
  showAll: boolean;
  selection: string[];
  /** Words to find in a run; a search looks through all runs, whatever the scope. */
  search?: string;
  now?: number;
}

export function screen(input: Inputs): ScreenView {
  const now = input.now ?? Date.now();
  const words = searchWords(input.search ?? "");
  const inScope = words.length
    ? input.runs.filter((run) => matches(run, words, input.store.root))
    : runsIn(input.scope, input.runs, input.milestones);
  const shown = visible(inScope, input.showAll);
  const laid = layout(shown);
  const short = fmt.shortIds(input.runs.map((run) => run.id));
  const headerMetric = input.mainMetric ?? mostCommon(shown.map((run) => run.mainMetric(undefined)));
  const quick = inScope.filter((run) => run.trivial).length;
  const shownIds = new Set(shown.map((run) => run.id));
  const selection = input.selection.filter((id) => shownIds.has(id));

  let details: DetailsView | null = null;
  const byId = new Map(input.runs.map((run) => [run.id, run]));
  if (selection.length === 1) details = runDetails(byId.get(selection[0])!, byId, short, input.store, headerMetric);
  else if (selection.length === 0 && input.scope.kind === "milestone" && !words.length) details = milestoneDetails(input.scope.milestone, input.scope.number, byId, short, input.store);

  return {
    loaded: input.loaded,
    headerMetric: headerMetric ?? "Metric",
    graphWidth: Math.max(1, ...laid.map(rowWidth)),
    rows: laid.map((row) => rowView(row, short, input.mainMetric, headerMetric, now)),
    selection,
    empty: emptyText(input, inScope, shown, words),
    quickRuns: { count: input.showAll ? quick : inScope.length - shown.length, showing: input.showAll && quick > 0 },
    details,
    message: selection.length > 1 ? `${selection.length} runs selected. Compare two of them with the Compare button.` : null,
    search: input.search ?? "",
  };
}

function rowView(row: Row, short: Map<string, string>, setting: string | undefined, headerMetric: string | undefined, now: number): RowView {
  const run = row.run;
  const key = run.mainMetric(setting);
  return {
    id: run.id,
    short: short.get(run.id) ?? run.id,
    started: fmt.started(run.startedAt),
    why: run.why ?? null,
    metric: fmt.result(run, key, now),
    metricKey: key && key !== headerMetric && run.status === "finished" ? key : null,
    status: run.status,
    spark: key ? run.spark(key).filter(Number.isFinite) : [],
    verdict: run.verdict ?? null,
    conclusion: run.conclusion ?? null,
    lane: row.lane,
    above: row.above.length,
    joining: row.joining,
    hasParent: row.hasParent,
    node: run.verdict === "drop" ? "drop"
      : run.status === "crashed" || run.status === "killed" ? "crashed"
      : run.status === "running" ? "running"
      : run.status === "lost" ? "lost"
      : run.verdict === "keep" ? "keep" : "plain",
  };
}

function emptyText(input: Inputs, inScope: Run[], shown: Run[], words: string[]): string[] {
  if (!input.loaded) return ["Loading runs..."];
  if (!input.runs.length) {
    return ["No runs yet", "Record one with: hunch run -m \"your hypothesis\" -- python train.py", "or add hunch.init() to your training script."];
  }
  if (shown.length) return [];
  if (words.length && !inScope.length) {
    return [`No runs match "${input.search!.trim()}"`, "Search looks at hypotheses, conclusions, commands, config and run ids."];
  }
  if (!inScope.length && input.scope.kind === "latest") return [`No runs since M${input.milestones.length}`, "Your next runs will appear here."];
  if (!inScope.length) return ["This milestone covers no runs"];
  return ["No runs to show"];
}

function mostCommon(values: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  for (const [v, n] of counts) if (best === undefined || n > counts.get(best)!) best = v;
  return best;
}

const select = (runId: string) => ({ command: "hunch.select", args: [runId] });
const reveal = (dir: string) => ({ command: "hunch.reveal", args: [dir] });

function runDetails(run: Run, byId: Map<string, Run>, short: Map<string, string>, store: Store, mainMetric: string | undefined): DetailsView {
  const rows: DetailsView["rows"] = [];
  const add = (label: string, text: string | undefined) => {
    if (text && text.trim()) rows.push({ label, value: { text } });
  };
  add("Status", status(run));
  if (run.remote) {
    const copied = run.remote.syncedAt ? fmt.started(run.remote.syncedAt) : "not yet";
    add("Remote", `ran on ${run.remote.machine}, copied home by Ferry (last copy ${copied})`);
  }
  add("Conclusion", [run.verdict, run.conclusion].filter(Boolean).join(": "));
  if (run.parent) {
    const parent = byId.get(run.parent);
    rows.push({ label: "Came from", value: { link: `${short.get(run.parent) ?? run.parent}  ${parent?.why ?? ""}`.trim(), ...select(run.parent) } });
  }
  add("Command", fmt.command(run, store.root));
  add("Code", code(run.dir, run.git));
  add("Config", Object.entries(fmt.flatten(asObject(asObject(readJson(path.join(run.dir, "config.json"))).values)))
    .map(([k, v]) => `${k} = ${fmt.value(v)}`).join("\n"));
  const env = asObject(readJson(path.join(run.dir, "env.json")));
  add("Environment", environment(env));
  add("GPU", gpus(env));
  const key = run.mainMetric(mainMetric);
  add("Metrics", [...run.metricKeys].sort((a, b) => Number(b === key) - Number(a === key))
    .map((k) => `${k}  ${fmt.value(run.finalMetrics[k])}`).join("\n"));
  add("History", run.notes.map((event) => {
    const kind = event.kind === "why" ? "hypothesis" : event.kind === "note" ? "conclusion" : String(event.kind);
    return `${String(event.at).slice(0, 16).replace("T", " ")}  ${kind}: ${event.value ?? "none"}`;
  }).join("\n"));
  rows.push({ label: "Folder", value: { link: path.relative(store.root, run.dir), ...reveal(run.dir) } });

  const actions: DetailsView["actions"] = [
    { label: "Keep", command: "hunch.keep", args: [{ runId: run.id }] },
    { label: "Drop", command: "hunch.drop", args: [{ runId: run.id }] },
    { label: "Write Conclusion...", command: "hunch.writeConclusion", args: [{ runId: run.id }] },
  ];
  if (run.parent && byId.has(run.parent)) actions.push({ label: "Compare with Parent", command: "hunch.compare", args: [{ runId: run.id }] });
  return {
    title: run.why ?? "No hypothesis",
    dimTitle: !run.why,
    subtitle: `${short.get(run.id) ?? run.id}  ·  started ${fmt.started(run.startedAt)}`,
    rows,
    actions,
  };
}

function milestoneDetails(milestone: Milestone, number: string, byId: Map<string, Run>, short: Map<string, string>, store: Store): DetailsView {
  const rows: DetailsView["rows"] = [];
  if (milestone.description) rows.push({ label: "Note", value: { text: milestone.description } });
  if (milestone.summary) rows.push({ label: "Summary", value: { text: milestone.summary } });
  const best = milestone.best ? byId.get(milestone.best) : undefined;
  if (best) {
    const metric = milestone.metric && milestone.metric in best.finalMetrics ? `  ${milestone.metric} ${fmt.value(best.finalMetrics[milestone.metric])}` : "";
    rows.push({ label: "Best run", value: { link: `${short.get(best.id) ?? best.id}  ${best.why ?? ""}${metric}`.trim(), ...select(best.id) } });
  }
  rows.push({ label: "Code", value: { text: code(milestone.dir, asObject(milestone.meta.git)) } });
  rows.push({ label: "Folder", value: { link: path.relative(store.root, milestone.dir), ...reveal(milestone.dir) } });
  return {
    title: milestone.title || "Untitled milestone",
    dimTitle: !milestone.title,
    subtitle: `${number}  ·  saved ${fmt.started(milestone.createdAt)}${milestone.line ? ` on ${milestone.line}` : ""}`,
    rows,
    actions: [],
  };
}

function status(run: Run): string {
  const took = fmt.duration(run.duration);
  const state = run.status === "finished" ? `finished in ${took}`
    : run.status === "running" ? "running"
    : run.status === "lost" ? "lost: no end was recorded and the heartbeat stopped"
    : run.status === "crashed" ? `crashed after ${took}${run.exitCode !== undefined ? `, exit ${run.exitCode}` : ""}`
    : run.status === "killed" ? `stopped after ${took}`
    : `${run.status} after ${took}`;
  const host = asString(run.host.hostname);
  return host ? `${state} on ${host}` : state;
}

function code(dir: string, git: Record<string, unknown> | undefined): string {
  const saved = files(dir);
  const text = saved === undefined ? "not saved (recorded before Hunch 0.2)" : `${saved.size} file${saved.size === 1 ? "" : "s"} saved`;
  if (!git || !Object.keys(git).length) return text;
  const commit = typeof git.commit === "string" ? git.commit.slice(0, 9) : "no commits yet";
  const dirty = git.dirty === true ? ", with uncommitted changes" : "";
  return `${text}\ngit ${commit} on ${typeof git.branch === "string" ? git.branch : "detached HEAD"}${dirty}`;
}

function environment(env: Record<string, unknown>): string | undefined {
  if (!Object.keys(env).length) return undefined;
  if (typeof env.error === "string") return env.error;
  const lines = [`Python ${env.python ?? "?"}`];
  const torch = asObject(env.torch);
  if (typeof torch.version === "string") lines.push(`torch ${torch.version}${typeof torch.cuda === "string" ? `, CUDA ${torch.cuda}` : ""}`);
  const packages = Object.keys(asObject(env.packages)).length;
  if (packages) lines.push(`${packages} packages`);
  return lines.join("\n");
}

function gpus(env: Record<string, unknown>): string | undefined {
  const list = asArray(env.gpus).map(asObject);
  if (!list.length) return undefined;
  const counts = new Map<string, number>();
  for (const gpu of list) counts.set(String(gpu.name), (counts.get(String(gpu.name)) ?? 0) + 1);
  const names = [...counts].map(([name, n]) => (n > 1 ? `${n} x ${name}` : name));
  const driver = list[0].driver;
  return names.join("\n") + (driver ? `\ndriver ${driver}` : "");
}
