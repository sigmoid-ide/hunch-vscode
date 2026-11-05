import * as path from "node:path";
import * as vscode from "vscode";
import * as fmt from "./model/format.ts";
import { asObject } from "./model/json.ts";
import type { Run } from "./model/run.ts";
import { changes, files, text } from "./model/snapshot.ts";
import { readJson, Store } from "./model/store.ts";

export const SCHEME = "hunch-run";

/**
 * Serves read-only documents for the diff editor: a run's config and metrics summary, or
 * one file from its code snapshot. The URI path ends in the file's name, so VS Code picks
 * the language for highlighting; the query says where to read it.
 */
export class RunDocuments implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const query = JSON.parse(uri.query) as { root: string; run: string; file?: string };
    const store = new Store(query.root);
    const runDir = path.join(store.runsDir, query.run);
    if (query.file === undefined) return readSummary(runDir, query.root);
    const sha = files(runDir)?.get(query.file);
    return sha ? text(store, sha) : "";
  }
}

/** Opens what changed between two runs: their config and metrics first, then every code file that differs. */
export async function compareRuns(store: Store, before: Run, after: Run, short: (run: Run) => string): Promise<void> {
  const uri = (run: Run, label: string, file?: string) =>
    // Both sides share the path, so the diff shows a change, not a rename; the query tells them apart.
    vscode.Uri.from({ scheme: SCHEME, path: `/${label}`, query: JSON.stringify({ root: store.root, run: run.id, file }) });

  const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = [];
  if (readSummary(before.dir, store.root) !== readSummary(after.dir, store.root)) {
    const right = uri(after, "Config and metrics.txt");
    resources.push([right, uri(before, "Config and metrics.txt"), right]);
  }
  const changed = changes(store, before, after);
  for (const change of changed ?? []) {
    const left = change.before !== undefined ? uri(before, change.path, change.path) : undefined;
    const right = change.after !== undefined ? uri(after, change.path, change.path) : undefined;
    resources.push([(right ?? left)!, left, right]);
  }

  if (!resources.length) {
    void vscode.window.showInformationMessage(changed === undefined
      ? "Code can't be compared: one of these runs was recorded before Hunch 0.2 saved code."
      : "These runs have the same code, config and metrics.");
    return;
  }
  const title = `${short(before)} ${before.why ?? ""} vs ${short(after)} ${after.why ?? ""}`.replace(/\s+/g, " ").trim();
  try {
    await vscode.commands.executeCommand("vscode.changes", title, resources);
  } catch {
    // Before the multi-file diff editor (VS Code 1.86): show the first difference.
    const [, left, right] = resources[0];
    await vscode.commands.executeCommand("vscode.diff", left ?? right, right ?? left, title);
  }
}

/** One line per setting and final metric, so the diff editor can line them up. */
function readSummary(runDir: string, root: string): string {
  const meta = asObject(readJson(path.join(runDir, "run.json")));
  const end = asObject(readJson(path.join(runDir, "end.json")));
  const config = asObject(asObject(readJson(path.join(runDir, "config.json"))).values);
  const lines = ["# command", fmt.command({ command: Array.isArray(meta.command) ? meta.command.map(String) : [] }, root), "", "# config"];
  for (const key of Object.keys(config).sort()) lines.push(`${key} = ${fmt.value(config[key])}`);
  lines.push("", "# final metrics");
  const metrics = asObject(end.metrics);
  for (const key of Object.keys(metrics).sort()) lines.push(`${key} = ${fmt.value(metrics[key])}`);
  return lines.join("\n") + "\n";
}
