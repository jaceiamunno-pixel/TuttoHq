import { describe, it, expect } from 'vitest';
import {
  deriveDurationDays,
  computeScheduleCpm,
  assembleSchedule,
  wouldCreateCycle,
  scheduleTaskCheckMessage,
  scheduleDepCheckMessage,
  type ScheduleTaskRow,
  type ScheduleDependencyRow,
} from './api';

// ── Mapping-seam tests (ADR-011 Phase 3, Slice 2) ────────────────────────────
// The HTTP/RLS/tenant behaviors need a live authenticated session; what's pure and
// deterministic — duration derivation, the row→engine→overlay merge, and the cycle
// gate — is proven here. 2024-01-01 is a Monday so working-day offsets are clean.

const MON = '2024-01-01'; // Mon
const FRI = '2024-01-05'; // Fri (same week)
const NEXT_MON = '2024-01-08';
const NEXT_FRI = '2024-01-12';

// Minimal task row; the seam only reads id/start/end/is_milestone, the rest rides
// through to the response untouched.
const taskRow = (
  id: string,
  start_date: string,
  end_date: string,
  is_milestone = false,
): ScheduleTaskRow => ({ id, start_date, end_date, is_milestone, name: id });

const depRow = (
  id: string,
  predecessor_id: string,
  successor_id: string,
  dep_type = 'FS',
  lag_days = 0,
): ScheduleDependencyRow => ({ id, predecessor_id, successor_id, dep_type, lag_days, project_id: 'p' });

describe('deriveDurationDays', () => {
  it('is 0 for a milestone regardless of dates', () => {
    expect(deriveDurationDays(MON, FRI, true)).toBe(0);
  });
  it('is 1 for a single-day task (start === end)', () => {
    expect(deriveDurationDays(MON, MON, false)).toBe(1);
  });
  it('is the inclusive working-day span (Mon→Fri = 5)', () => {
    expect(deriveDurationDays(MON, FRI, false)).toBe(5);
  });
  it('counts only working days across a weekend (Mon→next Mon = 6)', () => {
    expect(deriveDurationDays(MON, NEXT_MON, false)).toBe(6);
  });
});

describe('assembleSchedule — FS chain', () => {
  // A(5)→B(5)→C(5), contiguous Mon-anchored bars.
  const tasks = [
    taskRow('A', MON, FRI),
    taskRow('B', NEXT_MON, NEXT_FRI),
    taskRow('C', '2024-01-15', '2024-01-19'),
  ];
  const deps = [depRow('e1', 'A', 'B'), depRow('e2', 'B', 'C')];

  it('returns bars merged with the CPM overlay + a full critical path', () => {
    const out = assembleSchedule(tasks, deps);
    expect(out.cpm.ok).toBe(true);
    if (!out.cpm.ok) return;
    // Whole chain is the critical path; 15 working days end-to-end.
    expect(out.cpm.criticalPath).toEqual(['A', 'B', 'C']);
    expect(out.cpm.criticalTaskIds).toEqual(['A', 'B', 'C']);
    expect(out.cpm.projectDurationDays).toBe(15);
    expect(out.cpm.projectEnd).toBe('2024-01-19');

    const a = out.tasks.find((t) => t.id === 'A')!;
    expect(a.isCritical).toBe(true);
    expect(a.earlyStart).toBe(0);
    expect(a.totalFloat).toBe(0);
    expect(a.earlyStartDate).toBe(MON);
    expect(a.earlyFinishDate).toBe(FRI);
    // Row fields ride through untouched.
    expect(a.name).toBe('A');

    const b = out.tasks.find((t) => t.id === 'B')!;
    expect(b.earlyStart).toBe(5); // starts when A finishes (working-day offset)
    expect(b.earlyStartDate).toBe(NEXT_MON);

    expect(out.dependencies).toHaveLength(2);
  });
});

describe('assembleSchedule — float on a non-critical branch', () => {
  // A(5)→C and B(2)→C. C waits on A (the longer pred); B carries 3 days of float.
  const tasks = [
    taskRow('A', MON, FRI), // 5
    taskRow('B', MON, '2024-01-02'), // 2 (Mon–Tue)
    taskRow('C', NEXT_MON, NEXT_FRI), // 5
  ];
  const deps = [depRow('e1', 'A', 'C'), depRow('e2', 'B', 'C')];

  it('flags only the driving path critical, with correct float', () => {
    const out = assembleSchedule(tasks, deps);
    expect(out.cpm.ok).toBe(true);
    if (!out.cpm.ok) return;
    const byId = Object.fromEntries(out.tasks.map((t) => [t.id, t]));
    expect(byId.A.isCritical).toBe(true);
    expect(byId.A.totalFloat).toBe(0);
    expect(byId.C.isCritical).toBe(true);
    expect(byId.B.isCritical).toBe(false);
    expect(byId.B.totalFloat).toBe(3); // can slip 3 working days without moving C
    expect(out.cpm.criticalPath).toEqual(['A', 'C']);
  });
});

describe('cycle gate (wouldCreateCycle)', () => {
  const tasks = [taskRow('A', MON, FRI), taskRow('B', NEXT_MON, NEXT_FRI), taskRow('C', '2024-01-15', '2024-01-19')];
  const deps = [depRow('e1', 'A', 'B'), depRow('e2', 'B', 'C')];

  it('rejects an edge that closes a cycle (C→A on A→B→C) and names the nodes', () => {
    const gate = wouldCreateCycle(tasks, deps, { predecessor_id: 'C', successor_id: 'A', dep_type: 'FS', lag_days: 0 });
    expect(gate.cycle).toBe(true);
    if (!gate.cycle) return;
    expect([...gate.cycleNodeIds].sort()).toEqual(['A', 'B', 'C']);
  });

  it('allows a redundant but acyclic edge (A→C)', () => {
    const gate = wouldCreateCycle(tasks, deps, { predecessor_id: 'A', successor_id: 'C', dep_type: 'FS', lag_days: 0 });
    expect(gate.cycle).toBe(false);
  });
});

describe('assembleSchedule — degrade to rows-only on a CPM error (never throw)', () => {
  // A cyclic edge set should never reach a read (inserts are gated), but the GET
  // must still return bars + cpm:{ok:false} instead of 500ing.
  const tasks = [taskRow('A', MON, FRI), taskRow('B', NEXT_MON, NEXT_FRI)];
  const cyclic = [depRow('e1', 'A', 'B'), depRow('e2', 'B', 'A')];

  it('returns the raw rows without overlay and cpm.ok=false', () => {
    const out = assembleSchedule(tasks, cyclic);
    expect(out.cpm.ok).toBe(false);
    if (out.cpm.ok) return;
    expect(out.cpm.error).toBe('cycle');
    // No overlay merged — the bars are the untouched rows.
    expect(out.tasks).toHaveLength(2);
    expect('earlyStart' in out.tasks[0]).toBe(false);
    expect(out.tasks[0].name).toBe('A');
  });
});

describe('computeScheduleCpm — empty set', () => {
  it('is ok with an empty result (no crash on a bare project)', () => {
    const out = computeScheduleCpm([], []);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.tasks).toEqual([]);
    expect(out.projectDurationDays).toBe(0);
  });
});

describe('dangling edges from a soft-deleted task (regression — PR #45 pre-merge blocker)', () => {
  // A soft-deleted task's edges persist (lossless restore) but its id is absent from
  // the live task set. The seam must drop those edges before the engine runs, or the
  // cycle gate fails OPEN and the GET overlay collapses.

  it('GET keeps the CPM overlay when an edge points at a soft-deleted (absent) task', () => {
    // Edge A→B persists but A was soft-deleted (not in taskRows). B must still compute.
    const out = assembleSchedule([taskRow('B', MON, FRI)], [depRow('e1', 'A', 'B')]);
    expect(out.cpm.ok).toBe(true);
    if (!out.cpm.ok) return;
    const b = out.tasks.find((t) => t.id === 'B')!;
    expect(b.isCritical).toBe(true);
    expect(b.earlyStart).toBe(0); // no LIVE predecessor → starts at day 0
  });

  it('cycle gate is NOT bypassed by a dangling edge — a real live cycle is still rejected', () => {
    // X→B persists (X soft-deleted); live chain B→C→D; proposing D→B closes the live
    // cycle B→C→D→B. Pre-fix this slipped through (X→B → unknown_task → cycle:false).
    const tasks = [taskRow('B', MON, FRI), taskRow('C', NEXT_MON, NEXT_FRI), taskRow('D', '2024-01-15', '2024-01-19')];
    const deps = [depRow('eX', 'X', 'B'), depRow('e1', 'B', 'C'), depRow('e2', 'C', 'D')];
    const gate = wouldCreateCycle(tasks, deps, { predecessor_id: 'D', successor_id: 'B', dep_type: 'FS', lag_days: 0 });
    expect(gate.cycle).toBe(true);
    if (!gate.cycle) return;
    expect([...gate.cycleNodeIds].sort()).toEqual(['B', 'C', 'D']);
  });

  it('a dangling edge does not block a legitimate acyclic insert', () => {
    // X→B persists; proposing B→C is acyclic and must be allowed.
    const gate = wouldCreateCycle(
      [taskRow('B', MON, FRI), taskRow('C', NEXT_MON, NEXT_FRI)],
      [depRow('eX', 'X', 'B')],
      { predecessor_id: 'B', successor_id: 'C', dep_type: 'FS', lag_days: 0 },
    );
    expect(gate.cycle).toBe(false);
  });

  it('computeScheduleCpm drops dangling edges and still honors the live ones', () => {
    // Z→A is dangling (Z absent); A→B is live. A→B must still drive B; no unknown_task.
    const out = computeScheduleCpm(
      [taskRow('A', MON, FRI), taskRow('B', NEXT_MON, NEXT_FRI)],
      [depRow('eZ', 'Z', 'A'), depRow('e1', 'A', 'B')],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.tasks.find((t) => t.id === 'B')!.earlyStart).toBe(5); // A→B respected
  });
});

describe('backlog (null-dated) rows — overlay tolerance (migration 0023, Step 2a)', () => {
  // A backlog task carries null start/end. It must NOT enter the CPM engine (which
  // would deref a null date and THROW → GET 500) and must ride through to the response
  // untouched — no overlay merged, no day-0 collapse, no NaN.
  const backlogRow = (id: string): ScheduleTaskRow => ({
    id,
    start_date: null,
    end_date: null,
    is_milestone: false,
    name: id,
  });

  it('keeps the overlay for dated rows and passes a null-dated backlog row through untouched', () => {
    const out = assembleSchedule([taskRow('A', MON, FRI), backlogRow('BL')], []);
    expect(out.cpm.ok).toBe(true);
    if (!out.cpm.ok) return;
    const a = out.tasks.find((t) => t.id === 'A')!;
    expect(a.earlyStart).toBe(0); // dated row still computed normally
    const bl = out.tasks.find((t) => t.id === 'BL')!;
    expect(bl.start_date).toBeNull(); // NOT collapsed onto a date
    expect('earlyStart' in bl).toBe(false); // no overlay merged
    expect('totalFloat' in bl).toBe(false);
  });

  it('does not throw / NaN when the set is ONLY backlog rows', () => {
    const out = assembleSchedule([backlogRow('BL1'), backlogRow('BL2')], []);
    expect(out.cpm.ok).toBe(true);
    if (!out.cpm.ok) return;
    expect(out.cpm.projectDurationDays).toBe(0);
    expect(out.tasks).toHaveLength(2);
    expect('earlyStart' in out.tasks[0]).toBe(false);
  });

  it('drops a dependency edge that touches a backlog row (not schedulable)', () => {
    // A is dated; BL is backlog; edge BL→A must be dropped so A computes from day 0.
    const out = assembleSchedule([taskRow('A', MON, FRI), backlogRow('BL')], [depRow('e1', 'BL', 'A')]);
    expect(out.cpm.ok).toBe(true);
    if (!out.cpm.ok) return;
    expect(out.tasks.find((t) => t.id === 'A')!.earlyStart).toBe(0);
  });
});

describe('CHECK-violation → friendly message mappers', () => {
  it('maps the schedule_tasks CHECKs (23514)', () => {
    expect(scheduleTaskCheckMessage({ code: '23514', message: 'violates schedule_task_date_order' })).toMatch(/on or after/);
    expect(scheduleTaskCheckMessage({ code: '23514', message: 'violates schedule_task_pct' })).toMatch(/0.*100/);
    expect(scheduleTaskCheckMessage({ code: '23514', message: 'violates schedule_task_status' })).toMatch(/not_started/);
    expect(scheduleTaskCheckMessage({ code: '23505', message: 'unique' })).toBeNull(); // not a CHECK
  });
  it('maps the schedule_dependencies CHECKs (23514)', () => {
    expect(scheduleDepCheckMessage({ code: '23514', message: 'violates no_self_dependency' })).toMatch(/itself/);
    expect(scheduleDepCheckMessage({ code: '23514', message: 'violates schedule_dep_type' })).toMatch(/FS/);
    expect(scheduleDepCheckMessage(null)).toBeNull();
  });
});
