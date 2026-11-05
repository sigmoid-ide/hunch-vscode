import type { Run } from "./run.ts";
import type { Milestone } from "./store.ts";

/** What the run table shows: the runs since the last milestone, one milestone's runs, or all runs. */
export type Scope =
  | { kind: "latest"; key: "latest" }
  | { kind: "all"; key: "all" }
  | { kind: "milestone"; key: string; milestone: Milestone; number: string };

export const LATEST: Scope = { kind: "latest", key: "latest" };
export const ALL: Scope = { kind: "all", key: "all" };

/** The milestone list, newest first, or nothing when there are no milestones yet. */
export function scopes(milestones: Milestone[]): Scope[] {
  if (!milestones.length) return [];
  const numbered: Scope[] = milestones.map((milestone, index) => ({ kind: "milestone", key: milestone.id, milestone, number: `M${index + 1}` }));
  return [LATEST, ...numbered.reverse(), ALL];
}

export function runsIn(scope: Scope, runs: Run[], milestones: Milestone[]): Run[] {
  switch (scope.kind) {
    case "all":
      return runs;
    case "latest": {
      const covered = new Set(milestones.flatMap((milestone) => milestone.runs));
      return runs.filter((run) => !covered.has(run.id));
    }
    case "milestone": {
      const members = new Set(scope.milestone.runs);
      return runs.filter((run) => members.has(run.id));
    }
  }
}
