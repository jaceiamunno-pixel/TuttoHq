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
