<div align="center">
  <br/>
  <img src="media/icon.png" width="96" alt="Hunch logo" />

# Hunch for VS Code

**Every hunch, tracked. Now in VS Code.**

<a href="https://github.com/sigmoid-ide/hunch-vscode/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/sigmoid-ide/hunch-vscode/ci.yml?branch=main&style=for-the-badge&label=ci" alt="CI status" /></a>
<a href="https://marketplace.visualstudio.com/items?itemName=sigmoid-ide.hunch"><img src="https://img.shields.io/badge/VS_Code-Marketplace-6E56CF?style=for-the-badge" alt="On the VS Code Marketplace" /></a>
<a href="https://open-vsx.org/extension/sigmoid-ide/hunch"><img src="https://img.shields.io/badge/Open_VSX-Registry-6E56CF?style=for-the-badge" alt="On Open VSX" /></a>
<a href="https://github.com/sigmoid-ide/hunch-vscode/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-6E56CF?style=for-the-badge" alt="License: Apache-2.0" /></a>

</div>

Your [Hunch](https://github.com/sigmoid-ide/hunch) runs, one click away in the Activity Bar: what each run tried,
how it went, and what it showed.

![The Hunch panel: milestones, the tree of runs with their metric curves and conclusions, and one run's details](docs/screenshot.png)

- **The tree of runs**, with each run's hypothesis, main metric and its curve, and your conclusion. It updates while runs train.
- **Search and filter** all your runs: by hypothesis, conclusion, command, config or run id, or with filters
  such as `is:unreviewed`, `since:7d` or `val_loss<0.3`.
- **Run with Hunch**: in the Run button's menu, runs the current Python file under Hunch, asking why first.
  **Run with Hunch on...** runs it on one of your GPU machines with [Ferry](https://github.com/sigmoid-ide/ferry)
  (0.1.2 or newer) and brings the run home.
- **Keep or drop** a run and write its conclusion, from its details or a right-click.
- **Compare** a run with the one it came from, or any two runs: config, metrics and every changed file.
- **Milestones**: browse your runs milestone by milestone, and save one when you find something worth remembering.

Works in VS Code 1.85 or newer, Cursor, Windsurf and VSCodium, and over Remote SSH, WSL and Dev Containers.

## Get started

1. Install the extension: search for **Hunch** in the Extensions view, or open it on the
   [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sigmoid-ide.hunch) or, for Cursor,
   Windsurf and VSCodium, [Open VSX](https://open-vsx.org/extension/sigmoid-ide/hunch).
   Then install Hunch in your project's interpreter: `pip install sigmoid-hunch` (0.3.1 or newer).
2. Click the **Hunch** icon in the Activity Bar: your milestones open in the side bar and your runs in the panel.
   The status bar shows how many runs you have, or how many are training; click it to see them.
3. Run a script with **Run Python File with Hunch** from the Run button's menu, or from a terminal:
   `hunch run -m "why" -- python train.py`.

## Search and filters

Type words to find runs by hypothesis, conclusion, command, config or run id. Add filters to narrow it down,
or pick common ones from the filter button in the Runs view's title bar:

| Filter | Finds |
|---|---|
| `is:unreviewed` | ended runs with no verdict or conclusion yet |
| `is:kept`, `is:dropped` | runs by verdict |
| `is:running`, `is:crashed`, `is:stopped`, `is:lost` | runs by how they ended, or that they have not |
| `is:remote`, `on:gpu-box` | runs on another machine (with [Ferry](https://github.com/sigmoid-ide/ferry)), or a named one |
| `since:7d`, `since:today`, `since:2026-11-01` | runs started since then |
| `from:a7f3` | that run and every run that came from it |
| `branch:main` | runs started on a git branch |
| `val_loss<0.3`, `lr=3e-4`, `optimizer=adam` | a final metric or config value (`<`, `<=`, `>`, `>=`, `=`) |

A run must match every word and filter. `-` turns one around (`-is:dropped`), and commas mean either
(`is:crashed,stopped`).

## Keyboard

Ctrl+Alt+H in a Python file runs it with Hunch, asking why first.

In the runs table:

| Key | Does |
|---|---|
| Up, Down, Home, End | move between runs; with Shift, select several |
| Enter | compare the run with the one it came from, or the two selected runs |
| K, D | keep or drop the selected runs |
| C | write a conclusion |
| F2 | edit the hypothesis |
| Ctrl+F (Cmd+F on macOS) or / | go to the search box; Down comes back to the table, Escape clears it |

Everything else is in the Command Palette, under Hunch.

## Settings

`hunch.interpreter`: the Python that has Hunch. When empty, the extension uses the interpreter selected in the
Python extension, then `python` on PATH.

## Privacy

No telemetry, no network. The extension reads `.hunch/` and appends your notes to it. It runs Python only for
Run with Hunch and Save Milestone, and only in trusted workspaces. Run with Hunch on... starts Ferry, which
connects only to the machines you added to it.

<p align="center">Apache-2.0 · Part of Sigmoid IDE · Like it? Give it a star.</p>
