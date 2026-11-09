import * as path from "node:path";
import * as vscode from "vscode";
import { compareRuns } from "./compare.ts";
import { shortIds } from "./model/format.ts";
import type { Run } from "./model/run.ts";
import { ALL, runsIn } from "./model/scope.ts";
import { FILTER_MENU, hasFilter, search, withFilter } from "./model/search.ts";
import { offersAnswer, offerText, parseDuration, SEARCH_HINT, TIMES, timeCost, type Offer } from "./model/offers.ts";
import { ferryMachines, hasHunch, hunch, installInTerminal, interpreter, loginInTerminal, runFerry, runInTerminal, runOnInTerminal } from "./python.ts";
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
      if (state.search.trim() && !search(state.runs, state.search, state.store.root).some((run) => run.id === runId)) state.setSearch("");
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

    // The common filters, ticked in the search box's text so it stays the one place that says what is shown.
    vscode.commands.registerCommand("hunch.filter", async () => {
      type Item = vscode.QuickPickItem & { filter?: string; quick?: boolean };
      const items: Item[] = [
        ...FILTER_MENU.map((m) => ({
          label: m.label, description: m.filter, detail: "detail" in m ? m.detail : undefined, picked: hasFilter(state.search, m.filter), filter: m.filter,
        })),
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        { label: "Quick crashes", description: "runs that stopped or crashed in under 30 seconds", picked: state.showAll, quick: true },
      ];
      const chosen = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: "Filter Runs",
        placeHolder: "Filters go in the search box above the runs, where you can also type others, such as val_loss<0.3",
      });
      if (!chosen) return;
      let query = state.search;
      for (const m of FILTER_MENU) query = withFilter(query, m.filter, chosen.some((item) => item.filter === m.filter));
      state.setShowAll(chosen.some((item) => item.quick));
      state.setSearch(query);
    }),

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

    /** Runs the file on one of the user's machines with Ferry; `options` as for hunch.runFile, plus the machine's name. */
    vscode.commands.registerCommand("hunch.runFileOn", async (resource?: vscode.Uri, options?: { why?: string; machine?: string }) => {
      const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== "file") return void vscode.window.showInformationMessage("Open a Python file to run it with Hunch.");
      if (!(await trusted())) return;
      const cwd = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);
      const python = await interpreter(uri);
      const { ferry, answer } = await ferryMachines(python, cwd);
      if (answer.kind === "no-python") return void offerInstall(python, cwd, true);
      if (answer.kind === "no-ferry") return void offerFerry(python, cwd);
      if (answer.kind === "old-ferry") {
        const upgrade = ferry[0] === "ferry" ? "uv tool upgrade sigmoid-ferry" : `${python} -m pip install -U sigmoid-ferry`;
        return void vscode.window.showErrorMessage(`Running on another machine needs Ferry 0.1.2 or newer. Upgrade it with: ${upgrade}`);
      }
      if (answer.kind === "error") return void vscode.window.showErrorMessage(`Ferry: ${answer.message}`);
      const file = path.basename(uri.fsPath);
      let target: { where: string[]; label: string } | undefined;
      if (options?.machine) {
        target = { where: ["--on", options.machine], label: options.machine };
      } else {
        type Choice = vscode.QuickPickItem & { machine?: string; rent?: true; docs?: true };
        const choices: Choice[] = answer.machines.map((m) => (
          { label: m.name, description: m.gpu ?? "no GPU", detail: m.user ? `${m.user}@${m.host}` : m.host, machine: m.name }));
        if (choices.length) choices.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
        choices.push({ label: "$(cloud) Rent a GPU on Vast.ai...", detail: "With your own Vast.ai account; given back once the run is home", rent: true });
        if (!answer.machines.length) {
          choices.push({ label: "$(add) Add a machine of your own...", detail: "In a terminal: ferry add mybox user@host", docs: true });
        }
        const chosen = await vscode.window.showQuickPick(choices, { title: `Run ${file} with Hunch on`, placeHolder: "One of your machines, or a GPU to rent" });
        if (!chosen) return;
        if (chosen.docs) return void vscode.env.openExternal(vscode.Uri.parse("https://github.com/sigmoid-ide/ferry#readme"));
        target = chosen.rent ? await chooseRental(ferry, python, cwd) : { where: ["--on", chosen.machine!], label: chosen.machine! };
      }
      if (!target) return;
      const why = typeof options?.why === "string" ? options.why : await vscode.window.showInputBox({
        title: `Run ${file} with Hunch on ${target.label}`,
        prompt: "Why are you running this?",
        placeHolder: "Your hypothesis, e.g. warmup 1500 steps (optional)",
        ignoreFocusOut: true,
      });
      if (why === undefined) return;
      await vscode.workspace.saveAll(false); // Ferry sends the code as it is on disk
      runOnInTerminal(ferry, python, uri.fsPath, cwd, target.where, target.label, why.trim());
    }),
  ];
}

/**
 * Picks a GPU to rent on Vast.ai for one run: the offers (`ferry gpus --json`), then how long
 * at most, which shows the hourly price and the most it can cost. Ferry rents it when the run
 * starts and gives it back once the run is home.
 */
async function chooseRental(ferry: string[], python: string, cwd: string): Promise<{ where: string[]; label: string } | undefined> {
  const upgrade = ferry[0] === "ferry" ? "uv tool upgrade sigmoid-ferry" : `${python} -m pip install -U sigmoid-ferry`;
  const login = await runFerry(ferry, ["login", "vast", "--check"], cwd);
  if (!login.ok) {
    if (login.stderr.includes("invalid choice")) {
      return void vscode.window.showErrorMessage(`Renting a GPU needs Ferry 0.2 or newer. Upgrade it with: ${upgrade}`);
    }
    const choice = await vscode.window.showWarningMessage(
      "Renting a GPU needs your Vast.ai API key, once. Ferry keeps it in your system's keychain.", "Log In in Terminal");
    if (choice) loginInTerminal(ferry, cwd);
    return;
  }
  const picked = await pickOffer(ferry, cwd, upgrade);
  if (!picked) return;
  const { offer, words } = picked;
  const time = await pickTime(offer);
  if (!time) return;
  // The search words go along, so an offer taken instead of this one (if it fails) is found the same way.
  return { where: ["--rent", `${offer.id} ${words}`.trim(), "--for", time, "--yes"], label: `${offerText(offer).label} (Vast.ai)` };
}

/**
 * The GPUs to rent, cheapest first. What is typed goes to Vast.ai as search words (`ferry gpus
 * 4090 europe`), half a second after the typing stops, so a GPU that is not among the cheapest
 * is found too.
 */
function pickOffer(ferry: string[], cwd: string, upgrade: string): Promise<{ offer: Offer; words: string } | undefined> {
  type Item = vscode.QuickPickItem & { offer?: Offer };
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<Item>();
    pick.title = "Rent a GPU on Vast.ai";
    pick.placeholder = SEARCH_HINT;
    pick.ignoreFocusOut = true;
    let latest = 0;
    let shown = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const search = async (text: string) => {
      const ticket = ++latest;
      pick.busy = true;
      const out = await runFerry(ferry, ["gpus", "--json", "--", ...text.split(/\s+/).filter(Boolean)], cwd);
      if (ticket !== latest || done) return; // a newer search has started
      pick.busy = false;
      const answer = offersAnswer(out.ok, out.stdout, out.stderr);
      if (answer.kind === "old-ferry") {
        void vscode.window.showErrorMessage(`Renting a GPU needs Ferry 0.2 or newer. Upgrade it with: ${upgrade}`);
        return pick.hide();
      }
      // Every item shows whatever is typed: Vast.ai did the searching.
      if (answer.kind === "error") {
        pick.items = [{ label: `$(warning) ${answer.message}`, alwaysShow: true }];
        return;
      }
      shown = text.trim();
      pick.title = `Rent a GPU on Vast.ai: ${answer.understood}`;
      pick.items = answer.offers.length
        ? answer.offers.map((offer) => ({ ...offerText(offer), offer, alwaysShow: true }))
        : [{ label: "No GPU to rent for that right now", detail: "Try fewer words, another GPU or a higher price", alwaysShow: true }];
    };
    pick.onDidChangeValue((text) => {
      clearTimeout(timer);
      timer = setTimeout(() => void search(text), 500);
    });
    pick.onDidAccept(() => {
      const offer = pick.selectedItems[0]?.offer;
      if (!offer) return;
      done = true;
      resolve({ offer, words: shown });
      pick.hide();
    });
    pick.onDidHide(() => {
      clearTimeout(timer);
      if (!done) resolve(undefined);
      done = true;
      pick.dispose();
    });
    pick.show();
    void search("");
  });
}

/** How long the rented machine may run at most, from a short list with what each can cost; "Other..." takes any time. */
async function pickTime(offer: Offer): Promise<string | undefined> {
  type Item = vscode.QuickPickItem & { value: string };
  const items: Item[] = TIMES.map(([value, label]) => ({ label, description: timeCost(offer, parseDuration(value)!), value }));
  items.push({ label: "Other...", description: "such as 90m or 1h30m", value: "" });
  const chosen = await new Promise<Item | undefined>((resolve) => {
    const pick = vscode.window.createQuickPick<Item>();
    pick.title = `Rent ${offerText(offer).label} on Vast.ai for $${offer.price.toFixed(3)} an hour: for how long at most?`;
    pick.placeholder = "The machine destroys itself after this time, even if the run has not ended. Enter rents it";
    pick.items = items;
    pick.activeItems = [items[2]]; // 2 hours
    pick.ignoreFocusOut = true;
    let done = false;
    pick.onDidAccept(() => {
      done = true;
      resolve(pick.selectedItems[0]);
      pick.hide();
    });
    pick.onDidHide(() => {
      if (!done) resolve(undefined);
      pick.dispose();
    });
    pick.show();
  });
  if (!chosen || chosen.value) return chosen?.value;
  const typed = await vscode.window.showInputBox({
    title: `Rent ${offerText(offer).label} on Vast.ai for $${offer.price.toFixed(3)} an hour: for how long at most?`,
    prompt: "The machine destroys itself after this time, even if the run has not ended.",
    placeHolder: "such as 90m or 1h30m",
    ignoreFocusOut: true,
    validateInput: (text) => {
      const seconds = parseDuration(text);
      if (seconds === undefined) return "A time such as 2h, 90m or 1h30m, at least 10m";
      return { message: `${timeCost(offer, seconds)}. Enter rents it.`, severity: vscode.InputBoxValidationSeverity.Info };
    },
  });
  return typed?.trim().toLowerCase();
}

async function offerFerry(python: string, cwd: string): Promise<void> {
  const command = `${python} -m pip install -U sigmoid-ferry`;
  const choice = await vscode.window.showWarningMessage(
    `Running on another machine needs Ferry, in ${python} or as the ferry command.`, "Install in Terminal", "Copy Command");
  if (choice === "Install in Terminal") installInTerminal(python, cwd, true);
  else if (choice === "Copy Command") void vscode.env.clipboard.writeText(command);
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
