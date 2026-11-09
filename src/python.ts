import { execFile } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { machinesAnswer, type MachinesAnswer } from "./model/machines.ts";

/** What the Python extension's API offers, as far as Hunch uses it. */
interface PythonApi {
  environments?: {
    getActiveEnvironmentPath(resource?: vscode.Uri): { path: string };
    resolveEnvironment(env: { path: string } | string): Promise<{ executable: { uri?: vscode.Uri } } | undefined>;
  };
}

/**
 * The interpreter to run Hunch with: the `hunch.interpreter` setting, then the one selected
 * in the Python extension (when it is installed), then `python` on PATH.
 */
export async function interpreter(resource: vscode.Uri | undefined): Promise<string> {
  const setting = vscode.workspace.getConfiguration("hunch", resource).get<string>("interpreter")?.trim();
  if (setting) return setting;
  try {
    const extension = vscode.extensions.getExtension<PythonApi>("ms-python.python");
    if (extension) {
      const api = extension.isActive ? extension.exports : await extension.activate();
      const active = api.environments?.getActiveEnvironmentPath(resource);
      if (active?.path) {
        const resolved = await api.environments!.resolveEnvironment(active);
        return resolved?.executable.uri?.fsPath ?? active.path;
      }
    }
  } catch {
    // An old or different Python extension: fall back to PATH.
  }
  return process.platform === "win32" ? "python" : "python3";
}

export interface Output {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The program could not be started at all. */
  missing: boolean;
}

/** Runs `<python> -m hunch <args>` without a shell, so no argument needs quoting. */
export function hunch(python: string, args: string[], cwd: string): Promise<Output> {
  return new Promise((resolve) => {
    execFile(python, ["-m", "hunch", ...args], {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      timeout: 120_000,
      windowsHide: true,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      resolve({ ok: !error, stdout, stderr, missing: code === "ENOENT" });
    });
  });
}

/** True when the interpreter can import hunch. */
export async function hasHunch(python: string, cwd: string): Promise<boolean | "no-python"> {
  return new Promise((resolve) => {
    execFile(python, ["-c", "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('hunch') else 3)"], { cwd, timeout: 30_000, windowsHide: true }, (error) => {
      if (!error) resolve(true);
      else if ((error as NodeJS.ErrnoException).code === "ENOENT") resolve("no-python");
      else resolve(false);
    });
  });
}

type Shell = "pwsh" | "cmd" | "posix";

function shellKind(): Shell {
  const shell = path.basename(vscode.env.shell || "").toLowerCase();
  if (shell.startsWith("pwsh") || shell.startsWith("powershell")) return "pwsh";
  if (shell === "cmd.exe" || shell === "cmd") return "cmd";
  if (!shell && process.platform === "win32") return "pwsh";
  return "posix";
}

/** Quotes a path for the shell; only paths go through the shell, never the why. */
export function quote(text: string, shell: Shell, first = false): string {
  if (shell === "posix") return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
  if (/^[\w@%+=:,./\\-]+$/.test(text)) return text;
  if (shell === "cmd") return `"${text}"`;
  const quoted = `'${text.replace(/'/g, "''")}'`;
  return first ? `& ${quoted}` : quoted;
}

/**
 * Starts `hunch run` for a file in its own terminal, which activates the environment the
 * way the user's shell does. The why travels in HUNCH_WHY, so it never meets the shell.
 */
export function runInTerminal(python: string, file: string, cwd: string, why: string): vscode.Terminal {
  const shell = shellKind();
  const terminal = vscode.window.createTerminal({ name: `Hunch: ${path.basename(file)}`, cwd, env: { HUNCH_WHY: why } });
  const relative = path.relative(cwd, file);
  const script = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
  terminal.show();
  terminal.sendText(`${quote(python, shell, true)} -m hunch run -- ${quote(python, shell)} ${quote(script, shell)}`);
  return terminal;
}

/** Opens a terminal that installs Hunch, or with `ferry` Ferry (which brings Hunch along), into the interpreter. */
export function installInTerminal(python: string, cwd: string, ferry = false): void {
  const shell = shellKind();
  const terminal = vscode.window.createTerminal({ name: ferry ? "Install Ferry" : "Install Hunch", cwd });
  terminal.show();
  terminal.sendText(`${quote(python, shell, true)} -m pip install ${ferry ? "-U sigmoid-ferry" : "sigmoid-hunch"}`);
}

/**
 * The machines Ferry knows (`ferry add`), and the command that starts that Ferry: the
 * interpreter's own (`pip install sigmoid-ferry`), else a `ferry` command on PATH
 * (`uv tool install sigmoid-ferry`).
 */
export async function ferryMachines(python: string, cwd: string): Promise<{ ferry: string[]; answer: MachinesAnswer }> {
  const own = [python, "-m", "ferry"];
  const answer = await machines(own, cwd);
  if (answer.kind !== "no-ferry") return { ferry: own, answer };
  const tool = await machines(["ferry"], cwd);
  return tool.kind === "no-python" ? { ferry: own, answer } : { ferry: ["ferry"], answer: tool };
}

/** Asks one Ferry for its machines, without a shell. */
async function machines(ferry: string[], cwd: string): Promise<MachinesAnswer> {
  const out = await runFerry(ferry, ["machines", "--json"], cwd);
  return machinesAnswer(!out.missing, out.ok, out.stdout, out.stderr);
}

/** Runs `ferry <args>` without a shell, so no argument needs quoting. */
export function runFerry(ferry: string[], args: string[], cwd: string): Promise<Output> {
  return new Promise((resolve) => {
    execFile(ferry[0], [...ferry.slice(1), ...args], {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      timeout: 60_000,
      windowsHide: true,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      resolve({ ok: !error, stdout, stderr, missing: code === "ENOENT" });
    });
  });
}

/**
 * Starts `ferry run <where>` for a file in its own terminal: `where` is `--on <machine>`, or
 * `--rent <offer> --for <time> --yes`. The interpreter goes after `--` by its path, so Ferry
 * builds the machine's environment from it, wherever Ferry is installed.
 */
export function runOnInTerminal(ferry: string[], python: string, file: string, cwd: string, where: string[], label: string,
  why: string): vscode.Terminal {
  const shell = shellKind();
  const terminal = vscode.window.createTerminal({ name: `Hunch on ${label}: ${path.basename(file)}`, cwd, env: { HUNCH_WHY: why } });
  const relative = path.relative(cwd, file);
  const script = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
  const start = ferry.map((part, i) => quote(part, shell, i === 0)).join(" ");
  terminal.show();
  terminal.sendText(`${start} run ${where.map((part) => quote(part, shell)).join(" ")} -- ${quote(python, shell)} ${quote(script, shell)}`);
  return terminal;
}

/** Opens a terminal that asks for the Vast.ai API key, which Ferry keeps in the system's keychain. */
export function loginInTerminal(ferry: string[], cwd: string): void {
  const shell = shellKind();
  const terminal = vscode.window.createTerminal({ name: "Log in to Vast.ai", cwd });
  terminal.show();
  terminal.sendText(`${ferry.map((part, i) => quote(part, shell, i === 0)).join(" ")} login vast`);
}
