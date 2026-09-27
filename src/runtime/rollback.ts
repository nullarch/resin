// The state one run of the script body changes, saved so that the run can be discarded: a
// strategy(calc_on_order_fills=true) re-execution (Context.recalcOnOrderFills). The manual
// (strategies.txt, "calc_on_order_fills"): "the strategy recalculates on the same bar after an
// order fill", like a realtime bar, where "the script's variables are rolled back to their state
// at the bar's start" before every new execution (language_execution-model.txt, "Executions on
// realtime bars": "Pine Script rolls back the variables to their last committed values before
// each new execution"), `varip` excepted ("variables declared using the varip keyword ... are not
// subject to rollback"). The oracle rolls back the same parts around each re-execution (pynecore
// core/script_runner.py `_coof_loop`: the var slots without varip, the function instances, the
// drawings).
//
// What a run changes, and so what is saved:
// - the var/varip slots ($.vars, $.fnVars), varip excepted, and whatever objects they reach
//   (arrays, maps, matrices, UDT objects) — deep, restored in place, so that another reference to
//   the same object (a history slot, another var) sees it restored as well;
// - the state objects of the stateful calls ($.taSlots), deep in the same way: a first call made
//   in the discarded run leaves its lazily created fields behind otherwise;
// - the history buffers (Series.head: the value recorded for the current bar, the cursor of the
//   call-counted ones);
// - the drawings (drawing.ts journal).
// The per-bar outputs (plots, plot colors, viz channels) are rewritten by the run that counts.

import type { Context } from "./context";
import { closeDrawingJournal, isDrawingHandle, openDrawingJournal, rollbackDrawings } from "./drawing";
import type { RefSeries, Series } from "./series";

const ARRAY = 0;
const OBJECT = 1;
const MAP = 2;
const SET = 3;
const TYPED = 4;

// One object reached from the saved state, with its content at save time. The content keeps
// references to the nodes of the objects it holds, so sharing and cycles survive.
class Saved {
  readonly obj: object;
  readonly kind: number;
  readonly content: unknown[];

  constructor(obj: object, kind: number, content: unknown[]) {
    this.obj = obj;
    this.kind = kind;
    this.content = content;
  }
}

function save(v: unknown, seen: Map<object, Saved>): unknown {
  if (typeof v !== "object" || v === null) return v;
  // A drawing handle is a reference whose state the drawing journal restores.
  if (isDrawingHandle(v)) return v;
  const known = seen.get(v);
  if (known !== undefined) return known;
  let node: Saved;
  if (Array.isArray(v)) {
    node = new Saved(v, ARRAY, []);
    seen.set(v, node);
    for (const x of v) node.content.push(save(x, seen));
  } else if (ArrayBuffer.isView(v)) {
    node = new Saved(v, TYPED, [(v as unknown as Float64Array).slice()]);
    seen.set(v, node);
  } else if (v instanceof Map) {
    node = new Saved(v, MAP, []);
    seen.set(v, node);
    for (const [k, x] of v) node.content.push(save(k, seen), save(x, seen));
  } else if (v instanceof Set) {
    node = new Saved(v, SET, []);
    seen.set(v, node);
    for (const x of v) node.content.push(save(x, seen));
  } else {
    node = new Saved(v, OBJECT, []);
    seen.set(v, node);
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) node.content.push(k, save(o[k], seen));
  }
  return node;
}

function restore(v: unknown, done: Set<Saved>): unknown {
  if (!(v instanceof Saved)) return v;
  const obj = v.obj;
  if (done.has(v)) return obj;
  done.add(v);
  const c = v.content;
  switch (v.kind) {
    case ARRAY: {
      const a = obj as unknown[];
      a.length = c.length;
      for (let i = 0; i < c.length; i++) a[i] = restore(c[i], done);
      break;
    }
    case TYPED:
      (obj as Float64Array).set(c[0] as Float64Array);
      break;
    case MAP: {
      const m = obj as Map<unknown, unknown>;
      m.clear();
      for (let i = 0; i < c.length; i += 2) m.set(restore(c[i], done), restore(c[i + 1], done));
      break;
    }
    case SET: {
      const s = obj as Set<unknown>;
      s.clear();
      for (const x of c) s.add(restore(x, done));
      break;
    }
    default: {
      const o = obj as Record<string, unknown>;
      const keys = new Set<string>();
      for (let i = 0; i < c.length; i += 2) keys.add(c[i] as string);
      for (const k of Object.keys(o)) if (!keys.has(k)) delete o[k];
      for (let i = 0; i < c.length; i += 2) o[c[i] as string] = restore(c[i + 1], done);
    }
  }
  return obj;
}

// The state of a context at the start of a bar's body run (see the top of the file).
export class BarState {
  private readonly ctx: Context;
  private readonly vars: unknown[];
  private readonly fnVars: unknown[];
  private readonly taSlots: unknown[];
  private readonly hist: number[][];
  private readonly refHist: unknown[][];
  private readonly condHist: number[][];
  private readonly condRefHist: unknown[][];

  constructor(ctx: Context) {
    this.ctx = ctx;
    const seen = new Map<object, Saved>();
    const skipVars = ctx.intrabarVarSlots;
    const skipFnVars = ctx.intrabarFnVarSlots;
    this.vars = ctx.vars.map((v, i) => (skipVars.has(i) ? undefined : save(v, seen)));
    this.fnVars = ctx.fnVars.map((v, i) => (skipFnVars.has(i) ? undefined : save(v, seen)));
    this.taSlots = ctx.taSlots.map((s) => save(s, seen));
    this.hist = ctx.histSlots.map((s: Series) => s.head());
    this.refHist = ctx.refHistSlots.map((s: RefSeries) => s.head());
    this.condHist = ctx.condCallHistSlots.map((s: Series) => s.head());
    this.condRefHist = ctx.condCallRefHistSlots.map((s: RefSeries) => s.head());
    openDrawingJournal(ctx.drawingLog);
  }

  // Puts the saved state back; the drawings' journal stays open for the next run.
  restore(): void {
    const ctx = this.ctx;
    const done = new Set<Saved>();
    const skipVars = ctx.intrabarVarSlots;
    const skipFnVars = ctx.intrabarFnVarSlots;
    for (let i = 0; i < this.vars.length; i++) {
      if (!skipVars.has(i)) ctx.vars[i] = restore(this.vars[i], done) as Context["vars"][number];
    }
    for (let i = 0; i < this.fnVars.length; i++) {
      if (!skipFnVars.has(i)) ctx.fnVars[i] = restore(this.fnVars[i], done) as Context["fnVars"][number];
    }
    for (const s of this.taSlots) restore(s, done);
    ctx.histSlots.forEach((s, i) => s.restoreHead(this.hist[i]!));
    ctx.refHistSlots.forEach((s, i) => s.restoreHead(this.refHist[i]!));
    ctx.condCallHistSlots.forEach((s, i) => s.restoreHead(this.condHist[i]!));
    ctx.condCallRefHistSlots.forEach((s, i) => s.restoreHead(this.condRefHist[i]!));
    rollbackDrawings(ctx.drawingLog);
  }

  // The last restore: the run that follows counts.
  close(): void {
    this.restore();
    closeDrawingJournal();
  }
}
