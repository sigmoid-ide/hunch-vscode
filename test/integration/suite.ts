// Runs inside VS Code (see run.mjs), with the copy of test/store as the workspace.
import assert from "node:assert/strict";
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
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
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
];

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("sigmoid-ide.hunch");
  assert.ok(extension, "the extension is loaded");
  await extension.activate();
  // Show the panel, so a screenshot of a held window shows the views too.
  await vscode.commands.executeCommand("workbench.view.extension.hunch");

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
  const hold = Number(process.env.HUNCH_TEST_HOLD_MS ?? 0);
  if (hold) await sleep(hold);
  if (failed) throw new Error(`${failed} integration test(s) failed`);
}
