import { asArray, asObject, asString, parse } from "./json.ts";

/** A machine the user added with `ferry add`, as `ferry machines --json` lists it. */
export interface Machine {
  name: string;
  host: string;
  user?: string;
  gpu?: string;
}

/** What asking an interpreter's Ferry for its machines came to. */
export type MachinesAnswer =
  | { kind: "machines"; machines: Machine[] }
  | { kind: "no-python" }
  | { kind: "no-ferry" } // not installed in this interpreter
  | { kind: "old-ferry" } // installed, but older than 0.1.2, which lists machines as JSON
  | { kind: "error"; message: string };

/** Reads the outcome of `<python> -m ferry machines --json`. */
export function machinesAnswer(started: boolean, ok: boolean, stdout: string, stderr: string): MachinesAnswer {
  if (!started) return { kind: "no-python" };
  if (!ok) {
    if (/No module named ['"]?ferry/.test(stderr)) return { kind: "no-ferry" };
    if (/unrecognized arguments: --json/.test(stderr)) return { kind: "old-ferry" };
    const lines = stderr.trim().split(/\r?\n/);
    return { kind: "error", message: lines[lines.length - 1]?.replace(/^ferry: /, "") || "Ferry did not answer." };
  }
  try {
    const machines = asArray(parse(stdout)).map(asObject).flatMap((m) => {
      const name = asString(m.name);
      const host = asString(m.host);
      return name && host ? [{ name, host, user: asString(m.user), gpu: asString(m.gpu) }] : [];
    });
    return { kind: "machines", machines };
  } catch {
    return { kind: "error", message: "Ferry's machine list could not be read." };
  }
}
