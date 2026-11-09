// Reads test/store, written by the real hunch CLI: baseline, then warmup (kept, with a note),
// a milestone covering both, then from warmup a quick crash "typo" and "higher lr".
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { command, cost, duration, machine, result, shortIds, started, value } from "../src/model/format.ts";
import { rows, visible } from "../src/model/graph.ts";
import { parse, write } from "../src/model/json.ts";
import { Run } from "../src/model/run.ts";
import { machinesAnswer } from "../src/model/machines.ts";
import { LATEST, runsIn, scopes } from "../src/model/scope.ts";
import { hasFilter, search, withFilter } from "../src/model/search.ts";
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
  assert.deepEqual(remote.remote, { machine: "gpu-box", syncedAt: "2026-11-07T09:00:00+05:00", provider: undefined, country: undefined });
  assert.match(result(remote, undefined), /^running .* on gpu-box$/);
});

test("a run on a rented machine shows where it ran and what it cost", () => {
  const copy = copyStore();
  const folder = copy.runs().find((r) => r.why === "higher lr")!.dir;
  const details = () => {
    const all = copy.runs();
    const input = { store: copy, runs: all, milestones: copy.milestones(), scope: LATEST, mainMetric: undefined, loaded: true, showAll: false, selection: [all.find((r) => r.why === "higher lr")!.id] };
    return Object.fromEntries(screen(input).details!.rows.map((row) => [row.label, "text" in row.value ? row.value.text : row.value.link]));
  };
  const before = details();
  assert.equal(before.Cost, undefined);
  fs.writeFileSync(path.join(folder, "cost.json"), '{"estimate": 0.0');
  assert.deepEqual(details(), before); // a broken cost.json is no cost

  const signature = copy.signature(0);
  fs.writeFileSync(path.join(folder, "remote.json"), JSON.stringify({ machine: "vast-59870289", dir: "/root/.ferry/x", synced_at: "2026-11-09T14:03:00+05:00", complete: true,
    provider: "vast", tier: "verified", country: "PL", price: 0.0674 }));
  fs.writeFileSync(path.join(folder, "cost.json"), JSON.stringify({ provider: "vast", machine: "vast-59870289", gpu: "NVIDIA GeForce RTX 3060", rate: 0.06740740740740742,
    disk_rate: 0.007407, running_seconds: 48, stopped_seconds: 0, estimate: 0.0009, currency: "USD", billed: null }));
  assert.notEqual(copy.signature(0), signature);
  assert.deepEqual(copy.runs().find((r) => r.why === "higher lr")!.cost, { dollars: 0.0009, billed: false });
  const rented = details();
  assert.equal(rented.Remote, "ran on vast-59870289 (Vast.ai, PL), copied home by Ferry (last copy Nov 9 14:03)");
  assert.equal(rented.Cost, "under a cent");
  assert.equal(rented.Status, before.Status);

  fs.writeFileSync(path.join(folder, "cost.json"), JSON.stringify({ estimate: 0.0213, billed: 0.0241 }));
  assert.equal(details().Cost, "$0.02");
  assert.deepEqual([{ dollars: 0.0213, billed: false }, { dollars: 1.237, billed: false }, { dollars: 0.0213, billed: true }, { dollars: 0.004, billed: true }].map(cost),
    ["about $0.02", "about $1.24", "$0.02", "under a cent"]);
  assert.equal(machine({ machine: "gpu-box", syncedAt: undefined, provider: undefined, country: undefined }), "gpu-box");
  assert.equal(machine({ machine: "box", syncedAt: undefined, provider: "other", country: "" }), "box (other)");
});

test("search finds runs by hypothesis, conclusion, verdict, status, command, config and id, every word", () => {
  const found = (query: string) => search(runs, query, root).map((r) => r.why);
  assert.deepEqual(found("  HIGHER   "), ["higher lr"]);
  assert.deepEqual(found("приятно"), ["warmup"]); // its conclusion
  assert.deepEqual(found("keep"), ["warmup"]);
  assert.deepEqual(found("crashed"), ["typo"]);
  assert.deepEqual(found("train.py fail"), ["typo"]); // its command
  assert.deepEqual(found("lr = 0.3"), ["higher lr"]); // its config, as the details show it
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

test("filters narrow a search by status, verdict, time, lineage, metrics and config", () => {
  const started = Date.parse(run("baseline").startedAt);
  const found = (query: string, now = started + 3600_000) => search(runs, query, root, now).map((r) => r.why);
  const all = ["baseline", "warmup", "typo", "higher lr"];
  assert.deepEqual(found("is:kept"), ["warmup"]);
  assert.deepEqual(found("-is:kept"), ["baseline", "typo", "higher lr"]);
  assert.deepEqual(found("is:unreviewed"), ["baseline", "higher lr"]); // a quick crash is nothing to review
  assert.deepEqual(found("is:crashed,stopped"), ["typo"]);
  assert.deepEqual(found("IS:Finished -is:kept"), ["baseline", "higher lr"]);
  assert.deepEqual(found("val_loss<0.35"), ["warmup", "typo"]);
  assert.deepEqual(found("val_loss>=0.4"), ["baseline", "higher lr"]);
  assert.deepEqual(found("val_loss=0.4"), ["baseline"]); // as the table shows it: 0.4000000000000001 is 0.4
  assert.deepEqual(found("lr=3e-1"), ["higher lr"]); // config, in any notation
  assert.deepEqual(found("LR<0.2 is:finished"), ["baseline", "warmup"]);
  assert.deepEqual(found(`from:${run("warmup").id.slice(-4)}`), ["warmup", "typo", "higher lr"]);
  assert.deepEqual(found("since:1d"), all);
  assert.deepEqual(found("since:1d", started + 3 * 24 * 3600_000), []);
  assert.deepEqual(found("since:2026-11-04"), all);
  assert.deepEqual(found("since:2026-11-07"), []);
  assert.deepEqual(found("since:soon"), []); // not a filter, so a word no run has
  assert.deepEqual(found("nosuch<1"), []);

  assert.equal(withFilter("warmup  is:kept", "is:kept", false), "warmup");
  assert.equal(withFilter("warmup", "since:7d", true), "warmup since:7d");
  assert.ok(hasFilter("warmup since:7d", "since:7d") && !hasFilter("warmup", "since:7d"));
});

test("filters for where a run ran and the branch it started on", () => {
  const copy = copyStore();
  const dirOf = (why: string) => copy.runs().find((r) => r.why === why)!.dir;
  fs.writeFileSync(path.join(dirOf("higher lr"), "remote.json"), JSON.stringify({ machine: "gpu-box" }));
  const meta = JSON.parse(fs.readFileSync(path.join(dirOf("baseline"), "run.json"), "utf8"));
  fs.writeFileSync(path.join(dirOf("baseline"), "run.json"), JSON.stringify({ ...meta, line: "feature/warmup" }));
  const found = (query: string) => search(copy.runs(), query, copy.root).map((r) => r.why);
  assert.deepEqual(found("is:remote"), ["higher lr"]);
  assert.deepEqual(found("on:GPU"), ["higher lr"]);
  assert.deepEqual(found("branch:feature"), ["baseline"]);
});

test("reads Ferry's machines, and tells a missing Ferry from an old one", () => {
  const listed = machinesAnswer(true, true, '[{"name":"gpu","host":"10.0.0.5","user":"me","port":22,"gpu":"RTX 3060"},{"name":"cpu","host":"box"},{"host":"x"}]', "");
  assert.deepEqual(listed, { kind: "machines", machines: [
    { name: "gpu", host: "10.0.0.5", user: "me", gpu: "RTX 3060" },
    { name: "cpu", host: "box", user: undefined, gpu: undefined },
  ] });
  assert.deepEqual(machinesAnswer(true, true, "[]", ""), { kind: "machines", machines: [] });
  assert.deepEqual(machinesAnswer(false, false, "", ""), { kind: "no-python" });
  assert.deepEqual(machinesAnswer(true, false, "", "C:\py\python.exe: No module named ferry\n"), { kind: "no-ferry" });
  assert.deepEqual(machinesAnswer(true, false, "", "usage: ferry [-h]\nferry: error: unrecognized arguments: --json\n"), { kind: "old-ferry" });
  assert.deepEqual(machinesAnswer(true, false, "", "Traceback...\nferry: the machines file is broken\n"), { kind: "error", message: "the machines file is broken" });
  assert.equal(machinesAnswer(true, true, "not json", "").kind, "error");
});
