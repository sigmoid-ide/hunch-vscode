// Reads test/store, written by the real hunch CLI: baseline, then warmup (kept, with a note),
// a milestone covering both, then from warmup a quick crash "typo" and "higher lr".
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { command, duration, result, shortIds, started, value } from "../src/model/format.ts";
import { rows, visible } from "../src/model/graph.ts";
import { parse, write } from "../src/model/json.ts";
import { Run } from "../src/model/run.ts";
import { LATEST, runsIn, scopes } from "../src/model/scope.ts";
import { matches, searchWords } from "../src/model/search.ts";
import { changes } from "../src/model/snapshot.ts";
import { Store, timestamp } from "../src/model/store.ts";
import { screen } from "../src/viewModel.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "store");
const store = new Store(root);
const runs = store.runs();
const run = (why: string) => runs.find((r) => r.why === why)!;

function copyStore(): Store {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "hunch-store-"));
  fs.cpSync(root, copy, { recursive: true });
  return new Store(copy);
}

test("reads every run with its why, status, parent and verdict", () => {
  assert.deepEqual(runs.map((r) => r.why), ["baseline", "warmup", "typo", "higher lr"]);
  assert.deepEqual(runs.map((r) => r.status), ["finished", "finished", "crashed", "finished"]);
  assert.equal(run("warmup").parent, run("baseline").id);
  assert.equal(run("higher lr").parent, run("warmup").id);
  assert.equal(run("warmup").verdict, "keep");
  assert.equal(run("warmup").conclusion, "warmup helps, приятно");
  assert.equal(run("typo").exitCode, 3);
  assert.ok(run("typo").trivial);
  assert.ok(!run("baseline").trivial); // quick, but it finished
});

test("reads metrics like hunch log does", () => {
  const warmup = run("warmup");
  assert.equal(warmup.mainMetric(undefined), "val_loss");
  assert.equal(warmup.mainMetric("loss"), "loss");
  assert.deepEqual(warmup.metricKeys, ["loss", "val_loss"]);
  assert.equal(warmup.spark("val_loss").length, 5);
  assert.equal(result(warmup, "val_loss"), "0.3333");
  assert.equal(result(run("typo"), "val_loss"), "crashed, exit 3");
});

test("lays out the tree like hunch log, hiding quick crashes", () => {
  const all = rows(runs);
  assert.deepEqual(all.map((r) => r.run.why), ["higher lr", "typo", "warmup", "baseline"]);
  assert.deepEqual(all.map((r) => r.lane), [0, 1, 0, 0]);
  assert.deepEqual(all[2].joining, [0, 1]); // both children end at warmup
  assert.ok(!all[3].hasParent);

  const shown = rows(visible(runs, false));
  assert.deepEqual(shown.map((r) => r.run.why), ["higher lr", "warmup", "baseline"]);
  assert.ok(shown.every((r) => r.lane === 0));
});

test("reads milestones and splits runs by them", () => {
  const milestones = store.milestones();
  assert.equal(milestones.length, 1);
  const m = milestones[0];
  assert.equal(m.title, "warmup beats baseline");
  assert.equal(m.description, "the spike is gone");
  assert.deepEqual(m.runs, [run("baseline").id, run("warmup").id]);
  assert.equal(m.best, run("warmup").id);
  assert.ok(m.summary.startsWith("2 runs (1 kept)"));

  const list = scopes(milestones);
  assert.deepEqual(list.map((s) => s.key), ["latest", m.id, "all"]);
  assert.equal(list[1].kind === "milestone" && list[1].number, "M1");
  assert.deepEqual(runsIn(LATEST, runs, milestones).map((r) => r.why), ["typo", "higher lr"]);
  assert.deepEqual(runsIn(list[1], runs, milestones).map((r) => r.why), ["baseline", "warmup"]);
  assert.deepEqual(scopes([]), []);
});

test("reads code snapshots and finds what changed", () => {
  const found = changes(store, run("baseline"), run("warmup"))!;
  assert.deepEqual(found.map((c) => c.path), ["train.py"]);
  assert.ok(found[0].before!.includes("step + 1"));
  assert.ok(found[0].after!.includes("step + 2"));
  assert.deepEqual(changes(store, run("warmup"), run("higher lr")), []);
});

test("annotations are appended the way hunch writes them", () => {
  const copied = copyStore();
  const baseline = copied.runs().find((r) => r.why === "baseline")!;
  copied.annotate(baseline, "note", "line one\u2028still one");
  copied.annotate(baseline, "verdict", "drop");
  copied.annotate(baseline, "why", "a better why");
  const reread = copied.runs().find((r) => r.id === baseline.id)!;
  assert.equal(reread.conclusion, "line one\u2028still one");
  assert.equal(reread.verdict, "drop");
  assert.equal(reread.why, "a better why");
  assert.equal(reread.meta.why, "baseline"); // the record itself never changes
  const lines = fs.readFileSync(path.join(baseline.dir, "notes.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 3);
});

test("finds the store from a subfolder and notices changes", () => {
  assert.equal(Store.find(path.join(root, ".hunch", "runs")).root, root);
  const copied = copyStore();
  const before = copied.signature(0);
  copied.annotate(copied.runs()[0], "verdict", "keep");
  assert.notEqual(copied.signature(0), before);
});

test("reads python's json, including NaN and infinity", () => {
  const parsed = parse('{"a": [1, 2.5, -3e2, NaN, Infinity, -Infinity], "s": "caf\\u00e9 😀", "n": null, "t": true}') as Record<string, unknown>;
  const numbers = parsed.a as number[];
  assert.deepEqual(numbers.slice(0, 3), [1, 2.5, -300]);
  assert.ok(Number.isNaN(numbers[3]));
  assert.equal(numbers[4], Infinity);
  assert.equal(numbers[5], -Infinity);
  assert.equal(parsed.s, "café 😀");
  assert.equal(parsed.n, null);
  assert.throws(() => parse("{\"a\": 1} trailing"));
  assert.equal(write({ text: "a\u2028b" }), '{"text":"a\\u2028b"}');
});

test("numbers look like hunch's", () => {
  assert.deepEqual([2.3, 1 / 3, 1, 1234.6, 0.0003, 3e-5, 1e20, 7, NaN, true, null].map(value),
    ["2.3", "0.3333", "1", "1235", "0.0003", "3e-05", "1e+20", "7", "nan", "True", "None"]);
});

test("ids, times, durations and commands read short", () => {
  const ids = ["20261105-1723-aa1234", "20261105-1723-bb1234", "20261105-1724-cc5678"];
  assert.deepEqual([...shortIds(ids).values()], ["aa1234", "bb1234", "5678"]);
  assert.deepEqual([41.2, 723, 7500].map(duration), ["41s", "12m 3s", "2h 5m"]);
  assert.equal(started("2026-11-03T22:00:00.000+05:00"), "Nov 3 22:00");
  assert.match(timestamp(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);

  const project = fs.mkdtempSync(path.join(os.tmpdir(), "project-"));
  const meta = { started_at: "2026-11-05T10:00:00+00:00", command: [path.join(project, "venv", "python"), path.join(project, "train.py"), "--lr", "3e-4"] };
  const fake = new Run(path.join(project, "run"), "run", meta, undefined, [], undefined, []);
  assert.equal(command(fake, project), "python train.py --lr 3e-4");
});

test("a run Ferry copies from another machine stays running while this computer sleeps", () => {
  const copy = copyStore();
  const folder = copy.runs().find((r) => r.why === "higher lr")!.dir;
  fs.rmSync(path.join(folder, "end.json"));
  const old = new Date(Date.now() - 3 * 3600_000);
  fs.writeFileSync(path.join(folder, "heartbeat"), "");
  fs.utimesSync(path.join(folder, "heartbeat"), old, old);
  const reread = () => copy.runs().find((r) => r.why === "higher lr")!;
  assert.equal(reread().status, "lost");
  fs.writeFileSync(path.join(folder, "remote.json"), JSON.stringify({ machine: "gpu-box", dir: "/home/me/.ferry/x", synced_at: "2026-11-07T09:00:00+05:00" }));
  const remote = reread();
  assert.equal(remote.status, "running");
  assert.deepEqual(remote.remote, { machine: "gpu-box", syncedAt: "2026-11-07T09:00:00+05:00" });
  assert.match(result(remote, undefined), /^running .* on gpu-box$/);
});

test("search finds runs by hypothesis, conclusion, verdict, status, command, config and id, every word", () => {
  const found = (query: string) => runs.filter((r) => matches(r, searchWords(query), root)).map((r) => r.why);
  assert.deepEqual(searchWords("  Higher   LR "), ["higher", "lr"]);
  assert.deepEqual(found("HIGHER"), ["higher lr"]);
  assert.deepEqual(found("приятно"), ["warmup"]); // its conclusion
  assert.deepEqual(found("keep"), ["warmup"]);
  assert.deepEqual(found("crashed"), ["typo"]);
  assert.deepEqual(found("train.py fail"), ["typo"]); // its command
  assert.deepEqual(found("lr = 0.3"), ["higher lr"]); // its config
  assert.deepEqual(found(run("baseline").id.slice(-4)), ["baseline"]);
  assert.deepEqual(found("warmup baseline"), []);
});

test("a search looks through every run, not only the chosen milestone's", () => {
  const input = { store, runs, milestones: store.milestones(), scope: LATEST, mainMetric: undefined, loaded: true, showAll: false, selection: [] };
  assert.deepEqual(screen(input).rows.map((r) => r.why), ["higher lr"]); // since the milestone, without the quick crash
  assert.deepEqual(screen({ ...input, search: "warmup" }).rows.map((r) => r.why), ["warmup"]);
  const none = screen({ ...input, search: "  no such run " });
  assert.deepEqual(none.rows, []);
  assert.equal(none.empty[0], 'No runs match "no such run"');
  assert.equal(none.search, "  no such run ");
});
