import * as vscode from "vscode";
import { registerCommands } from "./commands.ts";
import { RunDocuments, SCHEME } from "./compare.ts";
import { MilestonesTree } from "./milestonesTree.ts";
import { RunsView } from "./runsView.ts";
import { HunchState } from "./state.ts";

export function activate(context: vscode.ExtensionContext): void {
  const state = new HunchState();
  const runs = new RunsView(context.extensionUri, state);
  void vscode.commands.executeCommand("setContext", "hunch.showingQuickRuns", false);
  context.subscriptions.push(
    state,
    runs,
    vscode.window.registerWebviewViewProvider("hunch.runs", runs),
    new MilestonesTree(state, context.extensionUri),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RunDocuments()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => state.reload(true)),
    ...registerCommands(state),
  );
}

export function deactivate(): void {}
