import * as vscode from "vscode";
import { runsIn, scopes, type Scope } from "./model/scope.ts";
import type { HunchState } from "./state.ts";

/** The milestone list beside the runs: what the run table shows comes from the item picked here. */
export class MilestonesTree implements vscode.TreeDataProvider<Scope>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<Scope>;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly state: HunchState;
  private readonly icons: { milestone: vscode.Uri };
  private items: Scope[] = [];
  /** Keys this tree is selecting itself, whose selection events must not change the scope. */
  private readonly revealing = new Set<string>();

  constructor(state: HunchState, extensionUri: vscode.Uri) {
    this.state = state;
    this.icons = { milestone: vscode.Uri.joinPath(extensionUri, "media", "milestone.svg") };
    this.view = vscode.window.createTreeView("hunch.milestones", { treeDataProvider: this, showCollapseAll: false });
    this.subscriptions.push(
      this.view,
      this.view.onDidChangeSelection((event) => {
        const picked = event.selection[0];
        if (!picked) return;
        // Selections this tree made itself (to follow the state) are not the user picking.
        if (this.revealing.delete(picked.key)) return;
        if (picked.key !== state.scope.key) state.setScope(picked);
      }),
      this.view.onDidChangeVisibility((event) => state.setVisible("milestones", event.visible)),
      state.onDidChange(() => this.refresh()),
    );
    state.setVisible("milestones", this.view.visible);
  }

  private refresh(): void {
    this.items = scopes(this.state.milestones);
    this.changed.fire();
    const current = this.items.find((s) => s.key === this.state.scope.key);
    if (current && this.view.visible && this.view.selection[0]?.key !== current.key) {
      const key = current.key;
      this.revealing.add(key);
      setTimeout(() => this.revealing.delete(key), 1000); // in case no selection event comes
      void this.view.reveal(current, { select: true, focus: false });
    }
  }

  getChildren(element?: Scope): Scope[] {
    return element ? [] : this.items;
  }

  getParent(): undefined {
    return undefined;
  }

  getTreeItem(scope: Scope): vscode.TreeItem {
    const count = runsIn(scope, this.state.runs, this.state.milestones).filter((run) => !run.trivial).length;
    const runs = `${count} run${count === 1 ? "" : "s"}`;
    switch (scope.kind) {
      case "latest": {
        const item = new vscode.TreeItem("Since last milestone");
        item.id = scope.key;
        item.description = runs;
        item.iconPath = new vscode.ThemeIcon("history");
        item.tooltip = "Runs that are not in a milestone yet";
        return item;
      }
      case "all": {
        const item = new vscode.TreeItem("All runs");
        item.id = scope.key;
        item.description = runs;
        item.iconPath = new vscode.ThemeIcon("list-tree");
        return item;
      }
      case "milestone": {
        const m = scope.milestone;
        const item = new vscode.TreeItem(`${scope.number}  ${m.title}`);
        item.id = scope.key;
        item.description = runs;
        item.iconPath = this.icons.milestone;
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**${escape(m.title)}**\n\n`);
        if (m.description) tooltip.appendMarkdown(`${escape(m.description)}\n\n`);
        if (m.summary) tooltip.appendMarkdown(escape(m.summary));
        item.tooltip = tooltip;
        return item;
      }
    }
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.changed.dispose();
  }
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}
