import { describe, it, expect } from 'vitest';
import {
  computeCpm,
  createWorkingCalendar,
  CRITICAL_FLOAT_THRESHOLD,
  type Task,
  type Dependency,
  type CpmSuccess,
  type CpmTaskResult,
} from './cpm';

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

const task = (id: string, durationDays: number, isMilestone = false): Task => ({
  id,
  durationDays,
  isMilestone,
});

const dep = (
  predecessorId: string,
  successorId: string,
  depType: Dependency['depType'] = 'FS',
  lagDays = 0,
): Dependency => ({ predecessorId, successorId, depType, lagDays });

/** Assert success and narrow the type, surfacing the error if it failed. */
function expectOk(result: ReturnType<typeof computeCpm>): CpmSuccess {
  if (!result.ok) {
    throw new Error(`Expected ok result, got error: ${JSON.stringify(result)}`);
  }
  return result;
}

function find(result: CpmSuccess, id: string): CpmTaskResult {
  const t = result.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`Task ${id} not found in result`);
  return t;
}

// A Monday, used wherever date offsets must be unambiguous.
const MONDAY = '2024-01-01';

// ---------------------------------------------------------------------------
// 1. Single task, no deps.
// ---------------------------------------------------------------------------

describe('1. single task, no dependencies', () => {
  const result = expectOk(computeCpm([task('A', 5)], [], MONDAY));
  const a = find(result, 'A');

  it('starts at project day 0 with zero float and is critical', () => {
    expect(a.earlyStart).toBe(0);
    expect(a.earlyFinish).toBe(5);
    expect(a.lateStart).toBe(0);
    expect(a.lateFinish).toBe(5);
    expect(a.totalFloat).toBe(0);
    expect(a.isCritical).toBe(true);
  });

  it('reports itself as the critical path', () => {
    expect(result.criticalTaskIds).toEqual(['A']);
    expect(result.criticalPath).toEqual(['A']);
    expect(result.criticalPaths).toEqual([['A']]);
    expect(result.projectDurationDays).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 2. Linear chain A→B→C (FS, no lag) — dates accumulate, all critical.
// ---------------------------------------------------------------------------

describe('2. linear chain A→B→C (FS, no lag)', () => {
  const tasks = [task('A', 2), task('B', 3), task('C', 2)];
  const deps = [dep('A', 'B'), dep('B', 'C')];
  const result = expectOk(computeCpm(tasks, deps, MONDAY));

  it('accumulates offsets along the chain', () => {
    expect(find(result, 'A').earlyStart).toBe(0);
    expect(find(result, 'A').earlyFinish).toBe(2);
    expect(find(result, 'B').earlyStart).toBe(2);
    expect(find(result, 'B').earlyFinish).toBe(5);
    expect(find(result, 'C').earlyStart).toBe(5);
    expect(find(result, 'C').earlyFinish).toBe(7);
    expect(result.projectDurationDays).toBe(7);
  });

  it('resolves accumulating calendar dates (Mon start, weekend skipped mid-chain)', () => {
    // A: Mon 1/1 – Tue 1/2 ; B: Wed 1/3 – Fri 1/5 ; C: Mon 1/8 – Tue 1/9
    expect(find(result, 'A').earlyStartDate).toBe('2024-01-01');
    expect(find(result, 'A').earlyFinishDate).toBe('2024-01-02');
    expect(find(result, 'B').earlyStartDate).toBe('2024-01-03');
    expect(find(result, 'B').earlyFinishDate).toBe('2024-01-05');
    expect(find(result, 'C').earlyStartDate).toBe('2024-01-08'); // skipped Sat 1/6, Sun 1/7
    expect(find(result, 'C').earlyFinishDate).toBe('2024-01-09');
  });

  it('marks every task critical with zero float', () => {
    for (const id of ['A', 'B', 'C']) {
      expect(find(result, id).totalFloat).toBe(0);
      expect(find(result, id).isCritical).toBe(true);
    }
    expect(result.criticalPath).toEqual(['A', 'B', 'C']);
  });
});

// ---------------------------------------------------------------------------
// 3. Parallel paths converging — longer path critical, shorter has positive
//    float equal to the difference.
// ---------------------------------------------------------------------------

describe('3. parallel converging paths', () => {
  // A→B→D (long, B=5) and A→C→D (short, C=2). Difference in length = 3.
  const tasks = [task('A', 1), task('B', 5), task('C', 2), task('D', 1)];
  const deps = [dep('A', 'B'), dep('B', 'D'), dep('A', 'C'), dep('C', 'D')];
  const result = expectOk(computeCpm(tasks, deps, MONDAY));

  it('makes the longer path critical', () => {
    expect(find(result, 'A').isCritical).toBe(true);
    expect(find(result, 'B').isCritical).toBe(true);
    expect(find(result, 'D').isCritical).toBe(true);
    expect(result.criticalPath).toEqual(['A', 'B', 'D']);
    expect(result.criticalTaskIds).toEqual(['A', 'B', 'D']);
  });

  it('gives the shorter path float equal to the path-length difference', () => {
    // B path contributes 5, C path contributes 2 → C float = 3.
    expect(find(result, 'C').totalFloat).toBe(3);
    expect(find(result, 'C').isCritical).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. KNOWN-ANSWER TEXTBOOK NETWORK (anchor test).
//
// Source: Heizer & Render, "Operations Management" — the "Milwaukee Paper
// Manufacturing" CPM example. Activities A–H, all Finish-to-Start, lag 0.
//   A:2 (—)   B:3 (—)   C:2 (A)   D:4 (B)
//   E:4 (C)   F:3 (C)   G:5 (D,E) H:2 (F,G)
// Published results (ES/EF/LS/LF/slack), project length 15,
// critical path A→C→E→G→H:
//   A 0/2/0/2 s0*   B 0/3/1/4 s1    C 2/4/2/4 s0*   D 3/7/4/8 s1
//   E 4/8/4/8 s0*   F 4/7/10/13 s6  G 8/13/8/13 s0* H 13/15/13/15 s0*
// ---------------------------------------------------------------------------

describe('4. known-answer textbook network (Milwaukee Paper, Heizer & Render)', () => {
  const tasks = [
    task('A', 2), task('B', 3), task('C', 2), task('D', 4),
    task('E', 4), task('F', 3), task('G', 5), task('H', 2),
  ];
  const deps = [
    dep('A', 'C'), dep('B', 'D'), dep('C', 'E'), dep('C', 'F'),
    dep('D', 'G'), dep('E', 'G'), dep('F', 'H'), dep('G', 'H'),
  ];
  const result = expectOk(computeCpm(tasks, deps, MONDAY));

  const expected: Record<string, [number, number, number, number, number]> = {
    // id: [ES, EF, LS, LF, totalFloat]
    A: [0, 2, 0, 2, 0],
    B: [0, 3, 1, 4, 1],
    C: [2, 4, 2, 4, 0],
    D: [3, 7, 4, 8, 1],
    E: [4, 8, 4, 8, 0],
    F: [4, 7, 10, 13, 6],
    G: [8, 13, 8, 13, 0],
    H: [13, 15, 13, 15, 0],
  };

  it('matches every published ES/EF/LS/LF/float', () => {
    for (const [id, [es, ef, ls, lf, tf]] of Object.entries(expected)) {
      const t = find(result, id);
      expect(t.earlyStart, `${id}.earlyStart`).toBe(es);
      expect(t.earlyFinish, `${id}.earlyFinish`).toBe(ef);
      expect(t.lateStart, `${id}.lateStart`).toBe(ls);
      expect(t.lateFinish, `${id}.lateFinish`).toBe(lf);
      expect(t.totalFloat, `${id}.totalFloat`).toBe(tf);
    }
  });

  it('reports the published project length and critical path A→C→E→G→H', () => {
    expect(result.projectDurationDays).toBe(15);
    expect(result.criticalTaskIds).toEqual(['A', 'C', 'E', 'G', 'H']);
    expect(result.criticalPath).toEqual(['A', 'C', 'E', 'G', 'H']);
    // Project finishes Fri 2024-01-19 (offset 14 inclusive from Mon 2024-01-01).
    expect(result.projectEnd).toBe('2024-01-19');
  });
});

// ---------------------------------------------------------------------------
// 5. Each edge type exercised (SS, FF, SF) — constraint date math.
// ---------------------------------------------------------------------------

describe('5. edge-type constraint math', () => {
  it('SS: successor starts when predecessor has started + lag', () => {
    // A:5 →(SS+2) B:3  ⇒ B.ES = A.ES + 2 = 2 ; B.EF = 5
    const r = expectOk(computeCpm([task('A', 5), task('B', 3)], [dep('A', 'B', 'SS', 2)], MONDAY));
    expect(find(r, 'B').earlyStart).toBe(2);
    expect(find(r, 'B').earlyFinish).toBe(5);
  });

  it('FF: successor finishes when predecessor has finished + lag', () => {
    // A:5 →(FF+1) B:3  ⇒ B.EF = A.EF + 1 = 6 ; B.ES = 3
    const r = expectOk(computeCpm([task('A', 5), task('B', 3)], [dep('A', 'B', 'FF', 1)], MONDAY));
    expect(find(r, 'B').earlyFinish).toBe(6);
    expect(find(r, 'B').earlyStart).toBe(3);
  });

  it('SF: successor finishes when predecessor has started + lag', () => {
    // A:5 →(SF+4) B:3  ⇒ B.EF = A.ES + 4 = 4 ; B.ES = 1
    const r = expectOk(computeCpm([task('A', 5), task('B', 3)], [dep('A', 'B', 'SF', 4)], MONDAY));
    expect(find(r, 'B').earlyFinish).toBe(4);
    expect(find(r, 'B').earlyStart).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Positive lag and negative lag (lead).
// ---------------------------------------------------------------------------

describe('6. lag and lead (negative lag)', () => {
  it('positive FS lag pushes the successor later', () => {
    // A:3 →(FS+2) B:2 ⇒ B.ES = 3 + 2 = 5
    const r = expectOk(computeCpm([task('A', 3), task('B', 2)], [dep('A', 'B', 'FS', 2)], MONDAY));
    expect(find(r, 'B').earlyStart).toBe(5);
    expect(find(r, 'B').earlyFinish).toBe(7);
  });

  it('negative FS lag (lead) pulls the successor earlier', () => {
    // A:3 →(FS-1) B:2 ⇒ B.ES = 3 - 1 = 2
    const r = expectOk(computeCpm([task('A', 3), task('B', 2)], [dep('A', 'B', 'FS', -1)], MONDAY));
    expect(find(r, 'B').earlyStart).toBe(2);
    expect(find(r, 'B').earlyFinish).toBe(4);
  });

  it('a lead that would precede project start is floored at day 0', () => {
    // A:1 →(SS-5) B:2 ⇒ candidate ES = 0 - 5 = -5, floored to 0
    const r = expectOk(computeCpm([task('A', 1), task('B', 2)], [dep('A', 'B', 'SS', -5)], MONDAY));
    expect(find(r, 'B').earlyStart).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. A milestone (duration 0) on the critical path.
// ---------------------------------------------------------------------------

describe('7. milestone on the critical path', () => {
  const tasks = [task('A', 4), task('M', 0, true), task('B', 3)];
  const deps = [dep('A', 'M'), dep('M', 'B')];
  const result = expectOk(computeCpm(tasks, deps, MONDAY));

  it('treats the milestone as a zero-length, zero-float critical node', () => {
    const m = find(result, 'M');
    expect(m.earlyStart).toBe(4);
    expect(m.earlyFinish).toBe(4); // EF == ES for a milestone
    expect(m.totalFloat).toBe(0);
    expect(m.isCritical).toBe(true);
    expect(m.earlyStartDate).toBe(m.earlyFinishDate); // collapses to one day
  });

  it('includes the milestone in the ordered critical path', () => {
    expect(result.criticalPath).toEqual(['A', 'M', 'B']);
  });
});

// ---------------------------------------------------------------------------
// 8. Weekend skipping — a Friday start lands the finish past the weekend.
// ---------------------------------------------------------------------------

describe('8. weekend skipping in calendar resolution', () => {
  it('a 3-working-day task starting Friday finishes the following Tuesday', () => {
    // Fri 2021-01-01 start; working days: Fri 1/1, Mon 1/4, Tue 1/5.
    const r = expectOk(computeCpm([task('A', 3)], [], '2021-01-01'));
    const a = find(r, 'A');
    expect(a.earlyStart).toBe(0);
    expect(a.earlyFinish).toBe(3);
    expect(a.earlyStartDate).toBe('2021-01-01');
    expect(a.earlyFinishDate).toBe('2021-01-05'); // skipped Sat 1/2 + Sun 1/3
    // Sanity: the finish is not a weekend day.
    const cal = createWorkingCalendar();
    expect(cal.isWorkingDay(new Date('2021-01-05T00:00:00Z'))).toBe(true);
  });

  it('a project start on a weekend snaps forward to the next working day', () => {
    // Sat 2021-01-02 → snaps to Mon 2021-01-04.
    const r = expectOk(computeCpm([task('A', 1)], [], '2021-01-02'));
    expect(r.projectStart).toBe('2021-01-04');
    expect(find(r, 'A').earlyStartDate).toBe('2021-01-04');
  });
});

// ---------------------------------------------------------------------------
// 9. A cycle (A→B→C→A) returns the typed error, does not hang.
// ---------------------------------------------------------------------------

describe('9. cyclic graph', () => {
  it('returns a typed cycle error and refuses to compute', () => {
    const tasks = [task('A', 1), task('B', 1), task('C', 1)];
    const deps = [dep('A', 'B'), dep('B', 'C'), dep('C', 'A')];
    const result = computeCpm(tasks, deps, MONDAY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('cycle');
      if (result.error === 'cycle') {
        expect([...result.cycleNodeIds].sort()).toEqual(['A', 'B', 'C']);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Empty graph — empty result, no crash.
// ---------------------------------------------------------------------------

describe('10. empty graph', () => {
  it('returns an empty success result', () => {
    const result = expectOk(computeCpm([], [], MONDAY));
    expect(result.tasks).toEqual([]);
    expect(result.criticalTaskIds).toEqual([]);
    expect(result.criticalPath).toEqual([]);
    expect(result.criticalPaths).toEqual([]);
    expect(result.projectDurationDays).toBe(0);
    expect(result.projectEnd).toBe(result.projectStart);
  });
});

// ---------------------------------------------------------------------------
// Extra robustness coverage (validation + determinism + threshold constant).
// ---------------------------------------------------------------------------

describe('robustness', () => {
  it('rejects a duplicate task id with a typed error', () => {
    const result = computeCpm([task('A', 1), task('A', 2)], [], MONDAY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('duplicate_task');
      if (result.error === 'duplicate_task') expect(result.taskId).toBe('A');
    }
  });

  it('rejects an edge that references an unknown task', () => {
    const result = computeCpm([task('A', 1)], [dep('A', 'Z')], MONDAY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('unknown_task');
      if (result.error === 'unknown_task') expect(result.taskId).toBe('Z');
    }
  });

  it('is deterministic — identical inputs yield identical output', () => {
    const tasks = [task('A', 2), task('B', 3), task('C', 2), task('D', 4)];
    const deps = [dep('A', 'B'), dep('A', 'C'), dep('B', 'D'), dep('C', 'D')];
    const r1 = computeCpm(tasks, deps, MONDAY);
    const r2 = computeCpm([...tasks].reverse(), [...deps].reverse(), MONDAY);
    expect(r1).toEqual(r2);
  });

  it('exposes the critical threshold as a named constant (0 in v1)', () => {
    expect(CRITICAL_FLOAT_THRESHOLD).toBe(0);
  });
});
