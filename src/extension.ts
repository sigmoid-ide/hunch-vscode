import * as vscode from "vscode";
import { registerCommands } from "./commands.ts";
import { RunDocuments, SCHEME } from "./compare.ts";
import { MilestonesTree } from "./milestonesTree.ts";
import { RunsView } from "./runsView.ts";
import { HunchState } from "./state.ts";
import { statusBar } from "./statusBar.ts";

export function activate(context: vscode.ExtensionContext): void {
  const state = new HunchState();
  const runs = new RunsView(context.extensionUri, state);
  void vscode.commands.executeCommand("setContext", "hunch.showingQuickRuns", false);
  context.subscriptions.push(
    state,
    runs,
    vscode.window.registerWebviewViewProvider("hunch.runs", runs),
    // The Milestones list sits in the side bar; opening it also opens the runs in the panel.
    new MilestonesTree(state, context.extensionUri, () => void runs.reveal(true)),
    statusBar(state),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RunDocuments()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => state.reload(true)),
    vscode.commands.registerCommand("hunch.showRuns", () => runs.reveal()),
    ...registerCommands(state),
  );
  state.reload();
  state.poll();
}

export function deactivate(): void {}
