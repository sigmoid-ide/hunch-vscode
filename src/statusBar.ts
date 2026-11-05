import * as vscode from "vscode";
import type { HunchState } from "./state.ts";

/** "Hunch: 8 runs", or "Hunch: 1 running" while something trains; a click shows the runs. */
export function statusBar(state: HunchState): vscode.Disposable {
  const item = vscode.window.createStatusBarItem("hunch.status", vscode.StatusBarAlignment.Left, 0);
  item.name = "Hunch";
  item.command = "hunch.showRuns";
  const update = () => {
    const runs = state.runs.filter((run) => !run.trivial);
    if (!state.store.exists() || !runs.length) {
      item.hide();
      return;
    }
    const running = runs.filter((run) => run.status === "running").length;
    item.text = running ? `$(sync~spin) Hunch: ${running} running` : `$(beaker) Hunch: ${runs.length} run${runs.length === 1 ? "" : "s"}`;
    item.tooltip = "Show your Hunch runs";
    item.show();
  };
  const subscription = state.onDidChange(update);
  update();
  return vscode.Disposable.from(item, subscription);
}
