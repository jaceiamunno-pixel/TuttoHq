/**
 * CPM (Critical Path Method) engine — ADR-011, Phase 3, Slice 1.
 *
 * PURE TypeScript. No I/O, no fetch, no Supabase, no React, no DB types, and
 * NO `Date.now()` nondeterminism — every date is derived from the caller-supplied
 * project-start ISO string. Given the same inputs it always returns the same
 * output, which is what makes it unit-testable to migration-grade scrutiny.
 *
 * The engine does standard forward/backward-pass CPM over a dependency graph
 * with four edge types (FS/SS/FF/SF) and integer lag/lead, expressed entirely
 * in WORKING days. Calendar dates are resolved only at the boundary, via an
 * injectable {@link WorkingCalendar}; the CPM math itself never looks at a
 * calendar. v1 working week = Mon–Fri, no holidays — but a holiday set can be
 * injected later (Phase-5) through the calendar WITHOUT touching the math here.
 *
 * Conventions (locked):
 *  - earlyStart/earlyFinish/lateStart/lateFinish are integer WORKING-day offsets
 *    from project day 0. EF = ES + duration (a milestone has duration 0, EF = ES).
 *  - A bar occupies working-day slots [ES, EF) — i.e. ES, ES+1, …, EF-1. The
 *    inclusive calendar finish date is therefore the slot at offset EF-1.
 *  - totalFloat = lateStart − earlyStart (== lateFinish − earlyFinish).
 *  - A task is critical when totalFloat <= CRITICAL_FLOAT_THRESHOLD (0 in v1).
 */

// ---------------------------------------------------------------------------
// Input types (defined here on purpose — keep the module DB-agnostic & pure).
// ---------------------------------------------------------------------------

export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF';

export interface Task {
  /** Stable unique id. */
  id: string;
  /** Duration in WORKING days. A milestone is duration 0. */
  durationDays: number;
  /** True for a zero-duration milestone (durationDays should be 0). */
  isMilestone?: boolean;
}

export interface Dependency {
  predecessorId: string;
  successorId: string;
  depType: DependencyType;
  /** Lag in WORKING days. Negative = lead. */
  lagDays: number;
}

// ---------------------------------------------------------------------------
// Output types.
// ---------------------------------------------------------------------------

export interface CpmTaskResult {
  id: string;
  /** WORKING-day offsets from project start. */
  earlyStart: number;
  earlyFinish: number;
  lateStart: number;
  lateFinish: number;
  /** Working days of slack. totalFloat <= threshold ⇒ critical. */
  totalFloat: number;
  isCritical: boolean;
  /** Resolved calendar dates (ISO yyyy-mm-dd). Inclusive bar span. */
  earlyStartDate: string;
  earlyFinishDate: string;
  lateStartDate: string;
  lateFinishDate: string;
}

export interface CpmSuccess {
  ok: true;
  /** Snapped project-start ISO date (day 0 — snaps forward to a working day). */
  projectStart: string;
  /** Inclusive ISO finish date of the whole project (max earlyFinish). */
  projectEnd: string;
  /** Project length in working days (max earlyFinish offset). */
  projectDurationDays: number;
  /** One entry per task, ordered by (earlyStart, then id) for stable reading. */
  tasks: CpmTaskResult[];
  /** All critical task ids (totalFloat <= threshold), sorted by id. */
  criticalTaskIds: string[];
  /**
   * The primary critical path: an ordered chain of zero-float tasks linked by
   * binding (schedule-driving) dependency edges. Chosen deterministically
   * (most tasks, then longest duration span, then lexicographically smallest).
   */
  criticalPath: string[];
  /** Every maximal critical chain (there can be parallel zero-float chains). */
  criticalPaths: string[][];
}

export type CpmError =
  | { ok: false; error: 'cycle'; cycleNodeIds: string[] }
  | { ok: false; error: 'duplicate_task'; taskId: string }
  | { ok: false; error: 'unknown_task'; taskId: string };

export type CpmResult = CpmSuccess | CpmError;

/**
 * v1 critical threshold. Float <= this ⇒ critical. 0 in v1; a positive value
 * (e.g. "near-critical within 2 days") or a negative-float deadline regime can
 * reuse this without code changes. Named so the meaning is never a magic 0.
 */
export const CRITICAL_FLOAT_THRESHOLD = 0;

// ---------------------------------------------------------------------------
// Working-day calendar — the ONLY place calendar arithmetic lives.
//
// Isolated behind this interface so a holiday set (Phase-5) injects here
// WITHOUT touching the CPM math. The engine calls it only to turn integer
// working-day offsets into ISO dates at the very end.
// ---------------------------------------------------------------------------

export interface WorkingCalendar {
  /** Is this calendar date a working day (not weekend, not a holiday)? */
  isWorkingDay(date: Date): boolean;
  /**
   * The date that is `n` working days from `start`. Day 0 snaps `start` forward
   * to the next working day. Supports negative `n` (leads).
   */
  addWorkingDays(start: Date, n: number): Date;
  /**
   * Inverse of addWorkingDays: working days you must add to `a` to reach `b`.
   * Provided for completeness / future use (e.g. importing as-built dates).
   */
  workingDaysBetween(a: Date, b: Date): number;
}

export interface WorkingCalendarOptions {
  /**
   * Days of week treated as non-working (0=Sun … 6=Sat). Default: Sat+Sun.
   * The working-week rule is stored explicitly so it is easy to flip.
   */
  weekend?: number[];
  /** ISO yyyy-mm-dd dates treated as non-working. Default: none (v1). */
  holidays?: Iterable<string>;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_WEEKEND = [0, 6]; // Sunday, Saturday

/** Parse an ISO yyyy-mm-dd into a UTC-midnight Date (TZ/DST-safe & deterministic). */
function parseIsoDate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) {
    throw new Error(`Invalid ISO date: "${iso}" (expected yyyy-mm-dd)`);
  }
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO date: "${iso}"`);
  }
  return date;
}

/** Format a UTC Date back to ISO yyyy-mm-dd. */
function toIsoDate(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const mo = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function addCalendarDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * MS_PER_DAY);
}

/**
 * Default Mon–Fri working calendar (no holidays). Accepts an injected weekend
 * rule and/or holiday set — this is the seam for the Phase-5 holiday calendar.
 */
export function createWorkingCalendar(
  options: WorkingCalendarOptions = {},
): WorkingCalendar {
  const weekend = new Set(options.weekend ?? DEFAULT_WEEKEND);
  const holidays = new Set<string>(options.holidays ?? []);

  function isWorkingDay(date: Date): boolean {
    if (weekend.has(date.getUTCDay())) return false;
    if (holidays.has(toIsoDate(date))) return false;
    return true;
  }

  function nextWorkingDay(date: Date, step: 1 | -1): Date {
    let d = date;
    do {
      d = addCalendarDays(d, step);
    } while (!isWorkingDay(d));
    return d;
  }

  function snapForward(date: Date): Date {
    let d = date;
    while (!isWorkingDay(d)) d = addCalendarDays(d, 1);
    return d;
  }

  function addWorkingDays(start: Date, n: number): Date {
    // Day 0 anchors on the first working day on/after `start`.
    let d = snapForward(start);
    if (n === 0) return d;
    const step: 1 | -1 = n > 0 ? 1 : -1;
    let remaining = Math.abs(n);
    while (remaining > 0) {
      d = nextWorkingDay(d, step);
      remaining -= 1;
    }
    return d;
  }

  function workingDaysBetween(a: Date, b: Date): number {
    const from = snapForward(a);
    const to = snapForward(b);
    if (from.getTime() === to.getTime()) return 0;
    const step: 1 | -1 = to.getTime() > from.getTime() ? 1 : -1;
    let count = 0;
    let d = from;
    while (d.getTime() !== to.getTime()) {
      d = nextWorkingDay(d, step);
      count += step;
    }
    return count;
  }

  return { isWorkingDay, addWorkingDays, workingDaysBetween };
}

// ---------------------------------------------------------------------------
// CPM engine.
// ---------------------------------------------------------------------------

export interface CpmOptions {
  /** Calendar used to resolve offsets → ISO dates. Default: Mon–Fri, no holidays. */
  calendar?: WorkingCalendar;
  /** Float <= this ⇒ critical. Default: {@link CRITICAL_FLOAT_THRESHOLD}. */
  criticalFloatThreshold?: number;
}

interface Edge {
  predecessorId: string;
  successorId: string;
  depType: DependencyType;
  lagDays: number;
}

/**
 * Compute the full CPM solution for a set of tasks + dependency edges.
 *
 * @param tasks            activities (durations in working days)
 * @param dependencies     dependency edges (type + lag in working days)
 * @param projectStartIso  schedule day 0, ISO yyyy-mm-dd
 * @param options          optional calendar / threshold injection
 *
 * Returns a typed error (never throws, never loops) on a cyclic graph,
 * duplicate task ids, or an edge referencing an unknown task.
 */
export function computeCpm(
  tasks: Task[],
  dependencies: Dependency[],
  projectStartIso: string,
  options: CpmOptions = {},
): CpmResult {
  const calendar = options.calendar ?? createWorkingCalendar();
  const threshold = options.criticalFloatThreshold ?? CRITICAL_FLOAT_THRESHOLD;
  const projectStartDate = calendar.addWorkingDays(parseIsoDate(projectStartIso), 0);
  const projectStartIsoSnapped = toIsoDate(projectStartDate);

  // --- Validate: duplicate ids -------------------------------------------------
  const byId = new Map<string, Task>();
  for (const t of tasks) {
    if (byId.has(t.id)) return { ok: false, error: 'duplicate_task', taskId: t.id };
    byId.set(t.id, t);
  }

  // Empty graph → empty result, no crash.
  if (tasks.length === 0) {
    return {
      ok: true,
      projectStart: projectStartIsoSnapped,
      projectEnd: projectStartIsoSnapped,
      projectDurationDays: 0,
      tasks: [],
      criticalTaskIds: [],
      criticalPath: [],
      criticalPaths: [],
    };
  }

  // --- Validate: edges reference known tasks -----------------------------------
  const edges: Edge[] = [];
  for (const dep of dependencies) {
    if (!byId.has(dep.predecessorId)) {
      return { ok: false, error: 'unknown_task', taskId: dep.predecessorId };
    }
    if (!byId.has(dep.successorId)) {
      return { ok: false, error: 'unknown_task', taskId: dep.successorId };
    }
    edges.push({
      predecessorId: dep.predecessorId,
      successorId: dep.successorId,
      depType: dep.depType,
      lagDays: dep.lagDays,
    });
  }

  // Sorted node ids → deterministic processing everywhere.
  const nodeIds = tasks.map((t) => t.id).sort();

  // Adjacency: outgoing (pred → [edge]) and incoming (succ → [edge]).
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  for (const id of nodeIds) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const e of edges) {
    outgoing.get(e.predecessorId)!.push(e);
    incoming.get(e.successorId)!.push(e);
  }

  // --- Cycle detection FIRST (typed error, never loop) -------------------------
  const topo = topoSort(nodeIds, outgoing);
  if (!topo.ok) return { ok: false, error: 'cycle', cycleNodeIds: topo.cycle };
  const order = topo.order; // predecessors before successors

  const dur = (id: string) => Math.max(0, byId.get(id)!.durationDays);

  // --- Forward pass: earlyStart / earlyFinish (working-day offsets) -------------
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  for (const id of order) {
    let earliest = 0; // floor at project day 0 — nothing starts before the project
    for (const e of incoming.get(id)!) {
      const pES = es.get(e.predecessorId)!;
      const pEF = ef.get(e.predecessorId)!;
      const d = dur(id);
      // Each edge type → a lower bound on this task's earlyStart.
      let bound: number;
      switch (e.depType) {
        case 'FS': bound = pEF + e.lagDays; break;           // succ.ES >= pred.EF + lag
        case 'SS': bound = pES + e.lagDays; break;           // succ.ES >= pred.ES + lag
        case 'FF': bound = pEF + e.lagDays - d; break;       // succ.EF >= pred.EF + lag
        case 'SF': bound = pES + e.lagDays - d; break;       // succ.EF >= pred.ES + lag
      }
      if (bound > earliest) earliest = bound;
    }
    es.set(id, earliest);
    ef.set(id, earliest + dur(id));
  }

  // Project end = latest earlyFinish across all tasks.
  let projectEndOffset = 0;
  for (const id of nodeIds) projectEndOffset = Math.max(projectEndOffset, ef.get(id)!);

  // --- Backward pass: lateFinish / lateStart -----------------------------------
  const lf = new Map<string, number>();
  const ls = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const d = dur(id);
    let latest = projectEndOffset; // cap: cannot finish later than the project end
    for (const e of outgoing.get(id)!) {
      const sLS = ls.get(e.successorId)!;
      const sLF = lf.get(e.successorId)!;
      // Reverse each forward constraint into an upper bound on this task's LF.
      let bound: number;
      switch (e.depType) {
        case 'FS': bound = sLS - e.lagDays; break;           // pred.LF <= succ.LS - lag
        case 'SS': bound = sLS - e.lagDays + d; break;       // pred.LS <= succ.LS - lag
        case 'FF': bound = sLF - e.lagDays; break;           // pred.LF <= succ.LF - lag
        case 'SF': bound = sLF - e.lagDays + d; break;       // pred.LS <= succ.LF - lag
      }
      if (bound < latest) latest = bound;
    }
    lf.set(id, latest);
    ls.set(id, latest - d);
  }

  // --- Assemble per-task results -----------------------------------------------
  const offsetToStartDate = (offset: number) =>
    toIsoDate(calendar.addWorkingDays(projectStartDate, offset));
  // Inclusive finish date: last occupied slot is offset (finish-1); a milestone
  // (start == finish offset) collapses to its single day.
  const offsetToFinishDate = (startOffset: number, finishOffset: number) =>
    toIsoDate(
      calendar.addWorkingDays(
        projectStartDate,
        finishOffset > startOffset ? finishOffset - 1 : startOffset,
      ),
    );

  const results: CpmTaskResult[] = nodeIds.map((id) => {
    const e0 = es.get(id)!;
    const e1 = ef.get(id)!;
    const l0 = ls.get(id)!;
    const l1 = lf.get(id)!;
    const totalFloat = l0 - e0;
    return {
      id,
      earlyStart: e0,
      earlyFinish: e1,
      lateStart: l0,
      lateFinish: l1,
      totalFloat,
      isCritical: totalFloat <= threshold,
      earlyStartDate: offsetToStartDate(e0),
      earlyFinishDate: offsetToFinishDate(e0, e1),
      lateStartDate: offsetToStartDate(l0),
      lateFinishDate: offsetToFinishDate(l0, l1),
    };
  });

  // Stable output order: by earlyStart, then id.
  results.sort((a, b) => (a.earlyStart - b.earlyStart) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const criticalSet = new Set(results.filter((r) => r.isCritical).map((r) => r.id));
  const criticalTaskIds = [...criticalSet].sort();

  // --- Critical path(s): maximal chains of binding edges between critical tasks --
  const criticalPaths = extractCriticalPaths(
    criticalSet,
    nodeIds,
    outgoing,
    es,
    ef,
  );
  const criticalPath = pickPrimaryPath(criticalPaths, dur);

  const projectEnd =
    projectEndOffset > 0
      ? offsetToStartDate(projectEndOffset - 1)
      : projectStartIsoSnapped;

  return {
    ok: true,
    projectStart: projectStartIsoSnapped,
    projectEnd,
    projectDurationDays: projectEndOffset,
    tasks: results,
    criticalTaskIds,
    criticalPath,
    criticalPaths,
  };
}

// ---------------------------------------------------------------------------
// Graph helpers.
// ---------------------------------------------------------------------------

/**
 * Kahn-style topological sort with deterministic (id-sorted) tie-breaking.
 * Returns the order (predecessors first) or a concrete cycle if one exists.
 */
function topoSort(
  nodeIds: string[],
  outgoing: Map<string, Edge[]>,
): { ok: true; order: string[] } | { ok: false; cycle: string[] } {
  const indegree = new Map<string, number>();
  for (const id of nodeIds) indegree.set(id, 0);
  for (const id of nodeIds) {
    for (const e of outgoing.get(id)!) {
      // Self-loops and parallel edges both legitimately raise indegree.
      indegree.set(e.successorId, (indegree.get(e.successorId) ?? 0) + 1);
    }
  }

  // nodeIds is pre-sorted; the ready list stays sorted by construction.
  const ready: string[] = nodeIds.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!; // smallest id (list stays sorted)
    order.push(id);
    const newlyReady: string[] = [];
    for (const e of outgoing.get(id)!) {
      const next = indegree.get(e.successorId)! - 1;
      indegree.set(e.successorId, next);
      if (next === 0) newlyReady.push(e.successorId);
    }
    if (newlyReady.length > 0) {
      // Keep `ready` sorted so ties break by id deterministically.
      newlyReady.sort();
      for (const n of newlyReady) insertSorted(ready, n);
    }
  }

  if (order.length === nodeIds.length) return { ok: true, order };
  // A cycle remains — extract a concrete one for the typed error.
  return { ok: false, cycle: findCycle(nodeIds, outgoing, indegree) };
}

function insertSorted(arr: string[], value: string): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, value);
}

/**
 * DFS over the nodes still carrying indegree (the cyclic remainder) to recover
 * one concrete cycle, returned in traversal order (e.g. ['A','B','C'] for
 * A→B→C→A). Deterministic via sorted iteration.
 */
function findCycle(
  nodeIds: string[],
  outgoing: Map<string, Edge[]>,
  indegree: Map<string, number>,
): string[] {
  const remaining = new Set(nodeIds.filter((id) => (indegree.get(id) ?? 0) > 0));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of remaining) color.set(id, WHITE);
  const stack: string[] = [];

  function dfs(id: string): string[] | null {
    color.set(id, GRAY);
    stack.push(id);
    const succs = outgoing
      .get(id)!
      .map((e) => e.successorId)
      .filter((s) => remaining.has(s))
      .sort();
    for (const s of succs) {
      if (color.get(s) === GRAY) {
        // Found a back-edge → cycle is stack[idx..] then back to s.
        const idx = stack.indexOf(s);
        return stack.slice(idx);
      }
      if (color.get(s) === WHITE) {
        const found = dfs(s);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  }

  for (const id of [...remaining].sort()) {
    if (color.get(id) === WHITE) {
      const found = dfs(id);
      if (found) return found;
    }
  }
  // Should be unreachable (a remainder implies a cycle), but stay defensive.
  return [...remaining].sort();
}

/** Is forward edge `e` binding (i.e. it actually drives the successor's timing)? */
function isBindingEdge(
  e: Edge,
  es: Map<string, number>,
  ef: Map<string, number>,
): boolean {
  const pES = es.get(e.predecessorId)!;
  const pEF = ef.get(e.predecessorId)!;
  const sES = es.get(e.successorId)!;
  const sEF = ef.get(e.successorId)!;
  switch (e.depType) {
    case 'FS': return sES === pEF + e.lagDays;
    case 'SS': return sES === pES + e.lagDays;
    case 'FF': return sEF === pEF + e.lagDays;
    case 'SF': return sEF === pES + e.lagDays;
  }
}

/**
 * Maximal chains of critical tasks connected by binding edges. Each chain is
 * ordered along the dependencies. A critical task connected to nothing binding
 * is returned as a singleton chain.
 */
function extractCriticalPaths(
  criticalSet: Set<string>,
  nodeIds: string[],
  outgoing: Map<string, Edge[]>,
  es: Map<string, number>,
  ef: Map<string, number>,
): string[][] {
  // Binding sub-graph restricted to critical nodes.
  const bindingOut = new Map<string, string[]>();
  const hasBindingIn = new Set<string>();
  for (const id of nodeIds) bindingOut.set(id, []);
  for (const id of nodeIds) {
    if (!criticalSet.has(id)) continue;
    for (const e of outgoing.get(id)!) {
      if (!criticalSet.has(e.successorId)) continue;
      if (!isBindingEdge(e, es, ef)) continue;
      bindingOut.get(id)!.push(e.successorId);
      hasBindingIn.add(e.successorId);
    }
  }
  for (const id of nodeIds) bindingOut.get(id)!.sort();

  // Sources = critical nodes with no incoming binding edge.
  const sources = [...criticalSet].filter((id) => !hasBindingIn.has(id)).sort();

  const paths: string[][] = [];
  const walk = (id: string, acc: string[]) => {
    const next = bindingOut.get(id)!.filter((s) => criticalSet.has(s));
    if (next.length === 0) {
      paths.push([...acc, id]);
      return;
    }
    for (const s of next) walk(s, [...acc, id]);
  };
  for (const src of sources) walk(src, []);

  // Stable order: longest first, then lexicographic by joined ids.
  paths.sort((a, b) => b.length - a.length || (a.join('>') < b.join('>') ? -1 : 1));
  return paths;
}

/** Pick the single "primary" critical path: most tasks, then longest span, then lexicographic. */
function pickPrimaryPath(paths: string[][], dur: (id: string) => number): string[] {
  if (paths.length === 0) return [];
  let best = paths[0];
  let bestSpan = best.reduce((sum, id) => sum + dur(id), 0);
  for (let i = 1; i < paths.length; i++) {
    const p = paths[i];
    const span = p.reduce((sum, id) => sum + dur(id), 0);
    if (
      p.length > best.length ||
      (p.length === best.length && span > bestSpan) ||
      (p.length === best.length && span === bestSpan && p.join('>') < best.join('>'))
    ) {
      best = p;
      bestSpan = span;
    }
  }
  return best;
}
