// Runs inside VS Code (see run.mjs), with the copy of test/store as the workspace.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Store } from "../../src/model/store.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(what: string, check: () => T | undefined, ms = 10_000): Promise<T> {
  for (let waited = 0; waited < ms; waited += 200) {
    const value = check();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const tests: [string, () => Promise<void>][] = [
  ["Compare with Parent opens the config and code changes in a diff", async () => {
    const root = workspaceRoot();
    const warmup = new Store(root).runs().find((run) => run.why === "warmup")!;
    await vscode.commands.executeCommand("hunch.compare", { runId: warmup.id });

    const tab = await waitFor("a compare tab", () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label.includes(" vs ")));
    console.log(`compare tab: "${tab.label}" (${tab.input?.constructor.name})`);
    assert.ok(tab.label.includes("baseline") && tab.label.includes("warmup"), tab.label);

    // The diff's sides are served by the extension: the code before and after.
    const docs = await waitFor("both sides of train.py", () => {
      const found = vscode.workspace.textDocuments.filter((d) => d.uri.scheme === "hunch-run" && d.uri.path.endsWith("train.py"));
      return found.length >= 2 ? found : undefined;
    });
    const texts = docs.map((d) => d.getText());
    assert.ok(texts.some((t) => t.includes("step + 1")), "the parent's code");
    assert.ok(texts.some((t) => t.includes("step + 2")), "the run's code");
    assert.equal(docs[0].languageId, "python");
  }],

  ["Keep writes the verdict to notes.jsonl", async () => {
    const root = workspaceRoot();
    const higher = new Store(root).runs().find((run) => run.why === "higher lr")!;
    await vscode.commands.executeCommand("hunch.keep", { runId: higher.id });
    assert.equal(new Store(root).runs().find((run) => run.id === higher.id)!.verdict, "keep");
  }],

  ["Run with Hunch records the run with its why, quotes and all", async () => {
    if (!python()) return skip("set HUNCH_TEST_PYTHON to a Python with Hunch 0.3.1 or newer");
    const root = workspaceRoot();
    const script = path.join(root, "quick.py");
    fs.writeFileSync(script, 'import hunch\nhunch.init(config={"lr": 0.1})\nhunch.log({"val_loss": 0.5})\n');
    const before = new Set(new Store(root).runs().map((run) => run.id));
    const why = `don't decay the lr; "quoted" & $HOME %PATH%`;
    await vscode.commands.executeCommand("hunch.runFile", vscode.Uri.file(script), { why });
    const run = await waitFor("the run to finish", () => new Store(root).runs().find((r) => !before.has(r.id) && r.end), 90_000);
    assert.equal(run.why, why);
    assert.equal(run.status, "finished");
    assert.equal(run.meta.source, "wrapper");
    assert.deepEqual(run.metricKeys, ["val_loss"]);
  }],

  ["Save Milestone saves the title and note as typed", async () => {
    if (!python()) return skip("set HUNCH_TEST_PYTHON to a Python with Hunch 0.3 or newer");
    const root = workspaceRoot();
    const title = "-5% loss, really";
    const note = `it's "quoted"`;
    await vscode.commands.executeCommand("hunch.saveMilestone", { title, note });
    const saved = await waitFor("the milestone", () => new Store(root).milestones().find((m) => m.title === title), 60_000);
    assert.equal(saved.description, note);
    assert.ok(saved.runs.length >= 1, "it covers the runs since the last milestone");
  }],
];

const workspaceRoot = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const python = () => process.env.HUNCH_TEST_PYTHON;
let skipped = 0;
function skip(reason: string): void {
  skipped++;
  console.log(`  (skipped: ${reason})`);
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("sigmoid-ide.hunch");
  assert.ok(extension, "the extension is loaded");
  await extension.activate();
  // Show the panel, so a screenshot of a held window shows the views too.
  await vscode.commands.executeCommand("workbench.view.extension.hunch");

  // Screenshot mode: select a run in a maximized panel and hold, instead of testing.
  const screenshot = process.env.HUNCH_SCREENSHOT_SELECT;
  if (screenshot) {
    for (const command of ["workbench.view.extension.hunch-sidebar", "workbench.action.closeAuxiliaryBar", "notifications.clearAll", "workbench.action.toggleMaximizedPanel"]) {
      await vscode.commands.executeCommand(command);
    }
    const run = new Store(workspaceRoot()).runs().find((r) => r.why === screenshot);
    if (run) await vscode.commands.executeCommand("hunch.select", run.id);
    await sleep(4000);
    await vscode.commands.executeCommand("notifications.clearAll"); // notices that arrived while starting
    await sleep(Number(process.env.HUNCH_TEST_HOLD_MS ?? 20_000));
    return;
  }

  let failed = 0;
  for (const [name, body] of tests) {
    try {
      await body();
      console.log(`  ok  ${name}`);
    } catch (error) {
      failed++;
      console.log(`  FAIL  ${name}\n${(error as Error).stack}`);
    }
  }
  if (skipped) console.log(`  ${skipped} skipped`);
  const hold = Number(process.env.HUNCH_TEST_HOLD_MS ?? 0);
  if (hold) await sleep(hold);
  if (failed) throw new Error(`${failed} integration test(s) failed`);
}
