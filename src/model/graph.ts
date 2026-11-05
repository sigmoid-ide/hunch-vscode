import type { Run } from "./run.ts";

/** One table row: a run, the lane its node sits in, and the lanes around it. */
export interface Row {
  run: Run;
  /** Lane of this run's node. */
  lane: number;
  /** Lanes coming in from the row above, as the run id each one is waiting for. */
  above: string[];
  /** Lanes going out to the row below. */
  below: string[];
  /** Indexes in `above` that end at this node (this run's children). */
  joining: number[];
  hasParent: boolean;
}

export function width(row: Row): number {
  return Math.max(row.above.length, row.below.length, row.lane + 1);
}

/** Hides quick crashes and stops, except those that other shown runs came from. */
export function visible(runs: Run[], showAll: boolean): Run[] {
  if (showAll) return runs;
  const byId = new Map(runs.map((run) => [run.id, run]));
  const keep = new Set(runs.filter((run) => !run.trivial).map((run) => run.id));
  const pending = [...keep];
  while (pending.length) {
    const parent = byId.get(pending.pop()!)?.parent;
    if (parent && byId.has(parent) && !keep.has(parent)) {
      keep.add(parent);
      pending.push(parent);
    }
  }
  return runs.filter((run) => keep.has(run.id));
}

/**
 * Lays runs out like `git log --graph --topo-order`, the way `hunch log` does: each
 * run's descendants sit right above it, newest branch first, and lanes are a stack,
 * so branches only ever join into the lane directly to their left.
 */
export function rows(runs: Run[]): Row[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const parentOf = new Map<string, string | undefined>();
  for (const run of runs) {
    const parent = run.parent ? byId.get(run.parent) : undefined;
    parentOf.set(run.id, parent && parent.startedMs < run.startedMs ? parent.id : undefined);
  }
  const children = new Map<string, Run[]>(runs.map((run) => [run.id, []]));
  const roots: Run[] = [];
  for (const run of runs) {
    const parent = parentOf.get(run.id);
    if (parent) children.get(parent)!.push(run);
    else roots.push(run);
  }

  // Newest start time in each run's subtree; children start after their parent.
  const latest = new Map<string, number>();
  for (const run of [...runs].sort((a, b) => b.startedMs - a.startedMs)) {
    latest.set(run.id, Math.max(run.startedMs, ...children.get(run.id)!.map((child) => latest.get(child.id)!)));
  }
  const byLatest = (a: Run, b: Run) => latest.get(a.id)! - latest.get(b.id)!;

  // Post-order without recursion, newest subtree first.
  const order: Run[] = [];
  const stack: [Run, boolean][] = [...roots].sort(byLatest).map((run) => [run, false]);
  while (stack.length) {
    const [run, expanded] = stack.pop()!;
    if (expanded) {
      order.push(run);
      continue;
    }
    stack.push([run, true]);
    for (const child of [...children.get(run.id)!].sort(byLatest)) stack.push([child, false]);
  }

  const lanes: string[] = [];
  return order.map((run) => {
    const above = [...lanes];
    const joining = above.map((id, index) => (id === run.id ? index : -1)).filter((index) => index >= 0);
    let lane: number;
    if (joining.length) {
      lane = joining[0];
      // The other children's lanes are to the right of the first one; close them.
      for (const index of joining.slice(1).reverse()) lanes.splice(index, 1);
    } else {
      lanes.push(run.id);
      lane = lanes.length - 1;
    }
    const parent = parentOf.get(run.id);
    if (parent) lanes[lane] = parent;
    else lanes.splice(lane, 1);
    return { run, lane, above, below: [...lanes], joining, hasParent: parent !== undefined };
  });
}
