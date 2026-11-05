import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { HunchState } from "./state.ts";
import { screen } from "./viewModel.ts";

/** Messages the webview sends. */
type FromView =
  | { type: "ready" }
  | { type: "select"; ids: string[] }
  | { type: "open"; id: string }
  | { type: "command"; command: string; args: unknown[] }
  | { type: "toggleQuickRuns" };

const ALLOWED_COMMANDS = new Set([
  "hunch.keep", "hunch.drop", "hunch.writeConclusion", "hunch.editHypothesis", "hunch.compare", "hunch.select", "hunch.reveal", "hunch.saveMilestone",
]);

/** The run table and the details of what is selected, drawn by media in a webview. */
export class RunsView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly extensionUri: vscode.Uri;
  private readonly state: HunchState;

  constructor(extensionUri: vscode.Uri, state: HunchState) {
    this.extensionUri = extensionUri;
    this.state = state;
    this.subscriptions.push(state.onDidChange(() => this.post()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [dist, media] };
    view.webview.html = this.html(view.webview, dist, media);
    view.webview.onDidReceiveMessage((message: FromView) => this.receive(message), undefined, this.subscriptions);
    view.onDidChangeVisibility(() => this.state.setVisible("runs", view.visible), undefined, this.subscriptions);
    view.onDidDispose(() => {
      this.view = undefined;
      this.state.setVisible("runs", false);
    }, undefined, this.subscriptions);
    this.state.setVisible("runs", view.visible);
  }

  private receive(message: FromView): void {
    switch (message.type) {
      case "ready":
        this.post();
        break;
      case "select":
        this.state.setSelection(message.ids);
        break;
      case "open":
        void vscode.commands.executeCommand("hunch.compare", { runId: message.id });
        break;
      case "toggleQuickRuns":
        this.state.setShowAll(!this.state.showAll);
        break;
      case "command":
        if (ALLOWED_COMMANDS.has(message.command)) void vscode.commands.executeCommand(message.command, ...message.args);
        break;
    }
  }

  private post(): void {
    if (!this.view) return;
    const s = this.state;
    const data = screen({
      store: s.store, runs: s.runs, milestones: s.milestones, scope: s.scope, mainMetric: s.mainMetric,
      loaded: s.loaded, showAll: s.showAll, selection: s.selection,
    });
    void this.view.webview.postMessage({ type: "screen", data });
    this.view.description = s.scope.kind === "milestone" ? `${s.scope.number}  ${s.scope.milestone.title}`
      : s.scope.kind === "all" || !s.milestones.length ? undefined : "Since last milestone";
  }

  private html(webview: vscode.Webview, dist: vscode.Uri, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString("hex");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, "runs.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "runs.css"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Runs</title>
</head>
<body>
<div id="app" data-vscode-context='{"preventDefaultContextMenuItems": true}'></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }
}
