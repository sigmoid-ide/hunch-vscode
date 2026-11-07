import * as path from "node:path";
import * as vscode from "vscode";
import { compareRuns } from "./compare.ts";
import { shortIds } from "./model/format.ts";
import type { Run } from "./model/run.ts";
import { ALL, runsIn } from "./model/scope.ts";
import { matches, searchWords } from "./model/search.ts";
import { hasHunch, hunch, installInTerminal, interpreter, runInTerminal } from "./python.ts";
import type { HunchState } from "./state.ts";

/** A right-click in the Runs view passes its row's context; buttons pass `{ runId }` too. */
type RunContext = { runId?: string } | undefined;

export function registerCommands(state: HunchState): vscode.Disposable[] {
  const short = (run: Run) => shortIds(state.runs.map((r) => r.id)).get(run.id) ?? run.id;

  /** The runs a command acts on: the clicked row (with the rest of the selection when it is part of it), else the selection. */
  const targets = (context: RunContext): Run[] => {
    const ids = context?.runId && !state.selection.includes(context.runId) ? [context.runId] : state.selection;
    return ids.map((id) => state.run(id)).filter((run): run is Run => run !== undefined);
  };

  const annotate = (runs: Run[], kind: "why" | "note" | "verdict", value: string) => {
    try {
      for (const run of runs) state.store.annotate(run, kind, value);
    } catch (error) {
      void vscode.window.showErrorMessage(`Couldn't save: ${(error as Error).message}`);
    }
    state.reload(true);
  };

  const editText = async (context: RunContext, kind: "why" | "note") => {
    const run = targets(context)[0];
    if (!run) return void vscode.window.showInformationMessage("Select a run first.");
    const text = await vscode.window.showInputBox({
      title: kind === "note" ? `Conclusion for ${short(run)}` : `Hypothesis for ${short(run)}`,
      prompt: kind === "note" ? "What did this run show?" : "Why did you run this?",
      value: (kind === "note" ? run.conclusion : run.why) ?? "",
      ignoreFocusOut: true,
    });
    if (text !== undefined && text.trim()) annotate([run], kind, text.trim());
  };

  return [
    vscode.commands.registerCommand("hunch.refresh", () => state.reload(true)),

    vscode.commands.registerCommand("hunch.select", (runId: string) => {
      state.ensureLoaded();
      // A run the search leaves out (such as a parent) ends the search, so it shows.
      const words = searchWords(state.search);
      if (words.length && !state.runs.some((run) => run.id === runId && matches(run, words, state.store.root))) state.setSearch("");
      // A run outside the current milestone is shown among all runs.
      if (!runsIn(state.scope, state.runs, state.milestones).some((run) => run.id === runId)) state.setScope(ALL);
      state.setSelection([runId]);
    }),

    vscode.commands.registerCommand("hunch.reveal", (dir: string) => vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(dir))),

    vscode.commands.registerCommand("hunch.openRunFolder", (context: RunContext) => {
      const run = targets(context)[0];
      if (run) return vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(run.dir));
    }),

    vscode.commands.registerCommand("hunch.keep", (context: RunContext) => annotate(targets(context), "verdict", "keep")),
    vscode.commands.registerCommand("hunch.drop", (context: RunContext) => annotate(targets(context), "verdict", "drop")),
    vscode.commands.registerCommand("hunch.writeConclusion", (context: RunContext) => editText(context, "note")),
    vscode.commands.registerCommand("hunch.editHypothesis", (context: RunContext) => editText(context, "why")),

    vscode.commands.registerCommand("hunch.showQuickRuns", () => state.setShowAll(true)),
    vscode.commands.registerCommand("hunch.hideQuickRuns", () => state.setShowAll(false)),

    /** Two runs: compare them, older first. One: compare it with the run it came from. */
    vscode.commands.registerCommand("hunch.compare", async (context: RunContext) => {
      const runs = targets(context);
      if (runs.length === 2) {
        const [a, b] = [...runs].sort((x, y) => x.startedMs - y.startedMs);
        return compareRuns(state.store, a, b, short);
      }
      if (runs.length !== 1) return void vscode.window.showInformationMessage("Select one run to compare with the run it came from, or two runs to compare them.");
      const parent = runs[0].parent ? state.run(runs[0].parent) : undefined;
      if (!parent) return void vscode.window.showInformationMessage("This run didn't come from another run. Select two runs to compare them.");
      return compareRuns(state.store, parent, runs[0], short);
    }),

    /** Asks for the title and note, unless `options.title` gives them (for keybindings, other extensions and tests). */
    vscode.commands.registerCommand("hunch.saveMilestone", async (options?: { title?: string; note?: string }) => {
      if (!(await trusted())) return;
      const given = typeof options?.title === "string" && options.title.trim() ? options : undefined;
      const title = given?.title ?? await vscode.window.showInputBox({
        title: "Save Milestone (1/2)",
        prompt: "What did you find? Hunch sums up the runs on this branch since the last milestone and saves your code.",
        placeHolder: "e.g. warmup + cosine beats baseline",
        validateInput: (value) => (value.trim() ? undefined : "Give the milestone a title"),
        ignoreFocusOut: true,
      });
      if (title === undefined) return;
      const note = given ? (given.note ?? "") : await vscode.window.showInputBox({
        title: "Save Milestone (2/2)",
        prompt: "Optional: what you found, in your own words.",
        placeHolder: "Press Enter to skip",
        ignoreFocusOut: true,
      });
      if (note === undefined) return;

      state.ensureLoaded();
      const root = state.store.root;
      const python = await interpreter(vscode.Uri.file(root));
      // The = form and -- keep a note or title that starts with "-" from reading as an option.
      const args = ["milestone", ...(note.trim() ? [`--note=${note.trim()}`] : []), "--", title.trim()];
      const before = new Set(state.milestones.map((m) => m.id));
      const output = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Saving milestone..." }, () => hunch(python, args, root));
      if (output.ok) {
        state.selectNewMilestoneAfter = before;
        const first = output.stdout.trim().split("\n")[0].replace(/^hunch: /, "");
        void vscode.window.showInformationMessage(first.charAt(0).toUpperCase() + first.slice(1));
        state.reload(true);
      } else if (output.missing || /No module named '?hunch/.test(output.stderr)) {
        void offerInstall(python, root, output.missing);
      } else if (output.stderr.includes("invalid choice")) {
        void vscode.window.showErrorMessage(`Saving milestones needs Hunch 0.3 or newer. Upgrade it with: ${python} -m pip install -U sigmoid-hunch`);
      } else {
        void vscode.window.showErrorMessage(output.stderr.trim().replace(/^hunch: /, "") || "Hunch couldn't save the milestone.");
      }
    }),

    /** Asks why, unless `options.why` gives it (for keybindings, other extensions and tests). */
    vscode.commands.registerCommand("hunch.runFile", async (resource?: vscode.Uri, options?: { why?: string }) => {
      const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== "file") return void vscode.window.showInformationMessage("Open a Python file to run it with Hunch.");
      if (!(await trusted())) return;
      await vscode.workspace.saveAll(false); // hunch saves the code from disk when the run starts
      const cwd = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);
      const python = await interpreter(uri);
      const installed = await hasHunch(python, cwd);
      if (installed !== true) return void offerInstall(python, cwd, installed === "no-python");
      const why = typeof options?.why === "string" ? options.why : await vscode.window.showInputBox({
        title: `Run ${path.basename(uri.fsPath)} with Hunch`,
        prompt: "Why are you running this?",
        placeHolder: "Your hypothesis, e.g. warmup 1500 steps (optional)",
        ignoreFocusOut: true,
      });
      if (why === undefined) return;
      runInTerminal(python, uri.fsPath, cwd, why.trim());
    }),
  ];
}

async function trusted(): Promise<boolean> {
  if (vscode.workspace.isTrusted) return true;
  const choice = await vscode.window.showWarningMessage("Running Python needs a trusted workspace.", "Manage Workspace Trust");
  if (choice) void vscode.commands.executeCommand("workbench.trust.manage");
  return false;
}

async function offerInstall(python: string, cwd: string, noPython: boolean): Promise<void> {
  if (noPython) {
    const choice = await vscode.window.showErrorMessage(
      `Couldn't start ${python}. Select an interpreter in the Python extension, or set hunch.interpreter.`, "Open Settings");
    if (choice) void vscode.commands.executeCommand("workbench.action.openSettings", "hunch.interpreter");
    return;
  }
  const command = `${python} -m pip install sigmoid-hunch`;
  const choice = await vscode.window.showWarningMessage(`Hunch isn't installed in ${python}.`, "Install in Terminal", "Copy Command");
  if (choice === "Install in Terminal") installInTerminal(python, cwd);
  else if (choice === "Copy Command") void vscode.env.clipboard.writeText(command);
}
