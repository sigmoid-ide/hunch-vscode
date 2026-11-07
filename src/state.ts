import * as vscode from "vscode";
import type { Run } from "./model/run.ts";
import { LATEST, scopes, type Scope } from "./model/scope.ts";
import { Store, type Milestone } from "./model/store.ts";

/** While a Hunch view is visible, and otherwise (for the status bar). */
const VISIBLE_POLL_MS = 2000;
const HIDDEN_POLL_MS = 10_000;

/**
 * The project's runs and milestones, reloaded whenever .hunch changes, plus what the user
 * chose to look at. Runs are written by other processes (hunch run, training scripts,
 * other machines), so this polls a cheap signature of the folder while a Hunch view is
 * visible, instead of relying on file events, which miss network drives and some mounts.
 */
export class HunchState implements vscode.Disposable {
  store: Store;
  runs: Run[] = [];
  milestones: Milestone[] = [];
  mainMetric: string | undefined;
  loaded = false;
  scope: Scope = LATEST;
  selection: string[] = [];
  showAll = false;
  /** Words to find in a run, typed in the Runs view; while there are any, the table shows matches from all runs. */
  search = "";
  /** Set after saving a milestone: the milestones before it, so the new one can be shown. */
  selectNewMilestoneAfter: Set<string> | undefined;

  private signature = "";
  private timer: ReturnType<typeof setInterval> | undefined;
  private interval = 0;
  private readonly visibleViews = new Set<string>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor() {
    this.store = findStore();
  }

  setVisible(view: string, visible: boolean): void {
    const shown = visible && !this.visibleViews.has(view);
    if (visible) this.visibleViews.add(view);
    else this.visibleViews.delete(view);
    if (shown) this.reload();
    this.poll();
  }

  /** Polls quickly while a Hunch view is visible, and slowly otherwise. */
  poll(): void {
    const interval = this.visibleViews.size ? VISIBLE_POLL_MS : HIDDEN_POLL_MS;
    if (interval === this.interval) return;
    if (this.timer) clearInterval(this.timer);
    this.interval = interval;
    this.timer = setInterval(() => this.reload(), interval);
  }

  /** Reloads when .hunch changed, or always with `force`. */
  reload(force = false): void {
    // The store may appear after the first run, possibly in a parent folder.
    if (!this.store.exists()) this.store = findStore();
    const now = Date.now();
    const signature = this.store.signature(now);
    if (!force && this.loaded && signature === this.signature) return;
    this.signature = signature;
    this.runs = this.store.runs(now);
    this.milestones = this.store.milestones();
    this.mainMetric = this.store.mainMetric();
    this.loaded = true;

    const before = this.selectNewMilestoneAfter;
    const saved = before && [...this.milestones].reverse().find((m) => !before.has(m.id));
    if (saved) {
      this.selectNewMilestoneAfter = undefined;
      this.scope = { kind: "milestone", key: saved.id, milestone: saved, number: "" };
      this.selection = [];
    }
    // Keep the chosen entry, refreshed; fall back to the runs since the last milestone.
    this.scope = scopes(this.milestones).find((s) => s.key === this.scope.key) ?? LATEST;
    this.changed.fire();
  }

  /** Loads on first use, for commands run before any Hunch view was shown. */
  ensureLoaded(): void {
    if (!this.loaded) this.reload();
  }

  /** Choosing a milestone ends a search, so the table shows that milestone. */
  setScope(scope: Scope): void {
    this.scope = scope;
    this.selection = [];
    this.search = "";
    this.changed.fire();
  }

  setSearch(search: string): void {
    this.search = search;
    this.changed.fire();
  }

  setSelection(ids: string[]): void {
    this.selection = ids;
    this.changed.fire();
  }

  setShowAll(showAll: boolean): void {
    this.showAll = showAll;
    void vscode.commands.executeCommand("setContext", "hunch.showingQuickRuns", showAll);
    this.changed.fire();
  }

  run(id: string): Run | undefined {
    this.ensureLoaded();
    return this.runs.find((run) => run.id === id);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.changed.dispose();
  }
}

/** The first workspace folder whose project has a .hunch store, else the first folder. */
function findStore(): Store {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const store = Store.find(folder.uri.fsPath);
    if (store.exists()) return store;
  }
  return new Store(folders[0]?.uri.fsPath ?? process.cwd());
}
