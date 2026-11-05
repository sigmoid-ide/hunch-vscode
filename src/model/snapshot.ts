import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { asObject, asString } from "./json.ts";
import type { Run } from "./run.ts";
import { readJson, type Store } from "./store.ts";

/**
 * A run's code snapshot: files.json lists each file's git blob SHA-1, and the blob
 * lives in .hunch/objects/<2 chars>/<38 chars> as a zlib-compressed git loose object.
 */

export interface Change {
  path: string;
  before: string | undefined;
  after: string | undefined;
}

/** Path to blob SHA, or undefined for runs recorded before snapshots (Hunch 0.1). */
export function files(dir: string): Map<string, string> | undefined {
  const manifest = readJson(path.join(dir, "files.json"));
  if (manifest === undefined) return undefined;
  const result = new Map<string, string>();
  for (const [file, entry] of Object.entries(asObject(asObject(manifest).files))) {
    const sha = asString(asObject(entry).sha);
    if (sha) result.set(file, sha);
  }
  return result;
}

/** A blob's content, or undefined when the object is missing or damaged. */
export function read(store: Store, sha: string): Buffer | undefined {
  try {
    const raw = zlib.inflateSync(fs.readFileSync(path.join(store.objects, sha.slice(0, 2), sha.slice(2))));
    const header = raw.indexOf(0);
    return header < 0 ? undefined : raw.subarray(header + 1);
  } catch {
    return undefined;
  }
}

export function text(store: Store, sha: string): string {
  return read(store, sha)?.toString("utf8") ?? "(missing from .hunch/objects)";
}

/** Files that differ between two runs; undefined when a run has no snapshot. */
export function changes(store: Store, before: Run, after: Run): Change[] | undefined {
  const old = files(before.dir);
  const now = files(after.dir);
  if (!old || !now) return undefined;
  const paths = [...new Set([...old.keys(), ...now.keys()])].sort();
  return paths.flatMap((file) => {
    const oldSha = old.get(file);
    const newSha = now.get(file);
    if (oldSha === newSha) return [];
    return [{ path: file, before: oldSha && text(store, oldSha), after: newSha && text(store, newSha) }];
  });
}
