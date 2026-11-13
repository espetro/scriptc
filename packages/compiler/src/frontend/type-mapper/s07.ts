// Statement slice of the former frontend/type-mapper.ts (split for
// maintainability; the directory barrel ../type-mapper.ts re-exports the
// original public surface). Statements are verbatim from the original file.
import { InternalCompilerError } from "../../errors.js";
import { typeKey } from "../../ir/ir.js";
import type { IrType, SrcLoc } from "../../ir/ir.js";
import { locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import type { DeclaredOrderPriority } from "./s00.js";
import { ShapeRegistry } from "./s01.js";
import { UnionRegistry, checkerTypeDescription } from "./s02.js";
import type { TypeMapperCtx } from "./s05.js";
import { activeWalk, verifiedSharedHits, walkStepLimit } from "./s06.js";


/** The overload sets whose signatures the equal-modulo-union-order arm is
 * mapping, outermost first. Mapping a signature maps its parameter and return
 * types, which can name the set again — `interface R { (x: number): R; (x:
 * string): R }` declared in a package, which isOverloadedCallableMemberType
 * does not claim. Each level would map every signature again, so a recursive
 * set expands exponentially until MAP_TYPE_MAX_DEPTH cuts every branch off. A
 * set already being expanded is refused instead (null, as every other
 * unmappable type), and the slot reports the overload diagnostic. */
export const overloadExpansion: (ts.Symbol | ts.Type)[] = [];


/** SCRIPTC_TYPE_MEMO_VERIFY=1: every hit on a shared (scope-independent)
 * memo entry is recomputed from scratch in the scope that took it and
 * compared. A mismatch is a miscompile the sharing would have introduced,
 * so the mode throws instead of quietly recomputing: it exists to prove the
 * sharing on a corpus, never to rescue it at run time. `=stats` also prints
 * how many hits it checked when the process exits. */
export const verifyMemoMode = process.env["SCRIPTC_TYPE_MEMO_VERIFY"] ?? "";

export const verifySharedTypeMemo = verifyMemoMode === "1" || verifyMemoMode === "stats";

if (verifyMemoMode === "stats") {
  process.on("exit", () => {
    process.stderr.write(`[type-memo] verified ${verifiedSharedHits} shared memo hits\n`);
  });
}


/** How many steps one walk may take: a step is a frame it computes, or an
 * entry it finds and cannot use. A walk maps each type it reaches once, so
 * its steps follow the number of types the mapped type reaches: the longest
 * walk of the compiler's own build takes 3,026 (a record of 2,440 members).
 * A walk that passes the limit is one the memo cannot shorten (answers that
 * differ below every ancestor), and it would run for minutes or without
 * end: the build ends with SC2016 instead, after a few seconds.
 * SCRIPTC_TYPE_WALK_STEPS sets another limit. */
export const TYPE_WALK_STEP_LIMIT = 500_000;


/** A type walk passed its step limit. It is thrown by the frame that takes
 * the walk over the limit and ends the build: lowerToIr reports it as
 * SC2016 at the declaration of the type the walk was mapping. Nothing
 * between the two may answer for the type instead (a lenient mapping of it
 * walks the same graph), so once it is thrown every later walk throws it
 * again, and a caller that swallowed it does not get far. */
export class TypeWalkBudgetError extends Error {
  constructor(
    readonly typeText: string,
    readonly steps: number,
    /** The type's declaration, when it has one. */
    readonly loc: SrcLoc | null,
  ) {
    super(`mapping type '${typeText}' takes more than ${steps} steps`);
  }
}


/** The walk that passed the step limit in this build, if one did. */
export let walkOverLimit: TypeWalkBudgetError | null = null;


/** A build starts: no walk has passed the step limit. */
export function resetTypeWalkBudget(): void {
  walkOverLimit = null;
}


export function walkPassedLimit(walk: TypeWalk, type: ts.Type, ctx: TypeMapperCtx): TypeWalkBudgetError {
  const root = walk.root ?? type;
  const declaration = (root.getAliasSymbol() ?? root.getSymbol())?.declarations[0];
  walkOverLimit = new TypeWalkBudgetError(
    ctx.checker.typeToString(root),
    walkStepLimit,
    declaration === undefined ? null : locOf(declaration),
  );
  return walkOverLimit;
}


/** The walk that passed the step limit since resetTypeWalkBudget, or null:
 * the build it belongs to ends with SC2016 even when the error was caught
 * on its way out. */
export function typeWalkOverLimit(): TypeWalkBudgetError | null {
  return walkOverLimit;
}


export const PROGRESS_RECORD = 0;

export const PROGRESS_UNION = 1;

export const PROGRESS_OVERLOADS = 2;


/** One mapping in progress of a record or union (ShapeRegistry.inProgress,
 * UnionRegistry.inProgress), or one overload set being expanded
 * (overloadExpansion). */
export class ProgressFrame {
  /** The dependency a frame takes when it answers from this one. */
  readonly dep: WalkDep;
  /** The same for an answer that only holds while this is in progress. */
  readonly strictDep: WalkDep;
  constructor(
    readonly kind: number,
    readonly key: ts.Type | ts.Symbol,
    /** The walk's clock when the mapping started. */
    readonly start: number,
    /** When earlier mappings of the same type started in this walk. */
    readonly earlier: number[] | undefined,
    /** The frame of the same key this one started inside. */
    readonly outer: ProgressFrame | undefined,
  ) {
    this.dep = new WalkDep(this, false);
    this.strictDep = new WalkDep(this, true);
  }
}


export class WalkDep {
  constructor(
    readonly frame: ProgressFrame,
    /** The answer was "it is in progress", not a recursive placeholder: the
     * finished recursive type does not stand in for it. */
    readonly strict: boolean,
  ) {}
}


export class WalkEntry {
  constructor(
    readonly result: IrType | null,
    readonly movedContext: boolean,
    readonly movedScope: boolean,
    readonly deps: readonly WalkDep[] | null,
    /** The clock spans the answer was computed in, as [from, to] pairs in
     * rising order: the frame's own span last, before it the spans of the
     * entries that served inside it. A record or union whose mapping started
     * inside one of them was mapped in full for this answer. */
    readonly spans: readonly number[],
    readonly depth: number,
    /** How far below `depth` the deepest frame of the walk sat. */
    readonly height: number,
    readonly metDepthLimit: boolean,
    readonly keyOrderRank: DeclaredOrderPriority,
    /** The erased member's "consulted an enclosing binding" flag at entry:
     * it decides whether an erased answer counts as a context resolution. */
    readonly outerConsulted: boolean,
  ) {}
}


export class TypeWalk {
  /** Frames computed so far. Entries and progress frames are stamped with
   * it. */
  clock = 0;
  /** Entries found that did not serve. With the clock, the walk's steps. */
  refused = 0;
  /** Set when the walk met something the bookkeeping does not describe (a
   * second registry): it then maps without the memo. */
  opaque = false;
  /** Entries computed at or before this clock may hold an answer of a type
   * whose recursive placeholder was minted or finished since. */
  staleBefore = 0;
  shapes: ShapeRegistry | null = null;
  unions: UnionRegistry | null = null;
  /** What the walk was started for (the statistics name it). */
  root: ts.Type | null = null;
  rootLenient = false;
  readonly entries = new Map<TypeMapperCtx, Map<unknown, Map<number, WalkEntry>>>();
  private lastCtx: TypeMapperCtx | null = null;
  private lastScope: unknown = undefined;
  private lastEntries: Map<number, WalkEntry> | null = null;
  readonly active: Map<ts.Type | ts.Symbol, ProgressFrame>[] = [new Map(), new Map(), new Map()];
  readonly finished: Map<ts.Type | ts.Symbol, number[]>[] = [new Map(), new Map(), new Map()];
  /** The frames in progress whose type was mapped in full earlier in this
   * walk: an entry computed around one of those mappings holds an answer
   * that a mapping below this frame would not give. */
  readonly reentered: ProgressFrame[] = [];

  entriesFor(ctx: TypeMapperCtx, scope: unknown): Map<number, WalkEntry> {
    if (this.lastCtx === ctx && this.lastScope === scope) return this.lastEntries!;
    let scopes = this.entries.get(ctx);
    if (scopes === undefined) this.entries.set(ctx, (scopes = new Map()));
    let entries = scopes.get(scope);
    if (entries === undefined) scopes.set(scope, (entries = new Map()));
    this.lastCtx = ctx;
    this.lastScope = scope;
    this.lastEntries = entries;
    return entries;
  }

  reset(): void {
    if (this.clock === 0) return;
    this.clock = 0;
    this.refused = 0;
    this.opaque = false;
    this.staleBefore = 0;
    this.shapes = null;
    this.unions = null;
    this.root = null;
    this.rootLenient = false;
    this.entries.clear();
    this.lastCtx = null;
    this.lastScope = undefined;
    this.lastEntries = null;
    for (const table of this.active) table.clear();
    for (const table of this.finished) table.clear();
    this.reentered.length = 0;
  }
}

/** The walk object top-level mappings take turns using. */
export const idleWalk = new TypeWalk();


/** The most span pairs an entry keeps; past it they become one span that
 * covers them all, which refuses more than it must and never less. */
export const WALK_ENTRY_SPANS = 32;


/** An entry's spans: `served` (pairs gathered from the entries that served
 * inside the frame) that end before the frame started, sorted and joined
 * where they touch, then the frame's own span. The ones inside the frame's
 * own span were computed, or served, inside it already. */
export function walkEntrySpans(served: number[] | null, started: number, ended: number): number[] {
  if (served === null) return [started, ended];
  const pairs: [number, number][] = [];
  for (let i = 0; i < served.length; i += 2)
    if (served[i + 1]! < started) pairs.push([served[i]!, served[i + 1]!]);
  if (pairs.length === 0) return [started, ended];
  pairs.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [from, to] of pairs) {
    const last = out.length - 1;
    if (last >= 0 && from <= out[last]! + 1) {
      if (to > out[last]!) out[last] = to;
    } else out.push(from, to);
  }
  if (out.length > WALK_ENTRY_SPANS * 2) return [out[0]!, out[out.length - 1]!, started, ended];
  out.push(started, ended);
  return out;
}

/** Bumped whenever a record, union or overload set starts mapping: only a
 * frame that saw it move is worth an entry. */
export let progressStarts = 0;


/** A record, union or overload set starts mapping (beside the registry's own
 * inProgress entry). Null outside a walk. */
export function walkEnter(
  kind: number,
  key: ts.Type | ts.Symbol,
  ctx: TypeMapperCtx,
): ProgressFrame | null {
  progressStarts++;
  const walk = activeWalk;
  if (walk === null) return null;
  if (walk.shapes === null) {
    walk.shapes = ctx.shapes;
    walk.unions = ctx.unions;
  } else if (walk.shapes !== ctx.shapes || walk.unions !== ctx.unions) {
    walk.opaque = true;
  }
  const table = walk.active[kind]!;
  const outer = table.get(key);
  // An overload set can start expanding again inside its own expansion (the
  // caller that asks first refuses it; one that does not ask expands it).
  // The inner frame stands for both until it ends.
  if (outer !== undefined) {
    const inner = new ProgressFrame(kind, key, outer.start, outer.earlier, outer);
    table.set(key, inner);
    return inner;
  }
  const earlier = walk.finished[kind]!.get(key);
  const frame = new ProgressFrame(kind, key, walk.clock, earlier, undefined);
  table.set(key, frame);
  if (earlier !== undefined) walk.reentered.push(frame);
  return frame;
}

export let walkEntriesVerified = 0;


/** SCRIPTC_TYPE_WALK_MEMO=verify: `served` was about to answer for `type`,
 * and `fresh` is what mapping it again gave. They must agree in the answer
 * and in the counters the frame moves. */
export function verifyWalkEntry(
  type: ts.Type,
  ctx: TypeMapperCtx,
  served: WalkEntry,
  fresh: WalkEntry,
): void {
  walkEntriesVerified++;
  const key = (t: IrType | null): string => (t === null ? "<unmapped>" : typeKey(t));
  if (
    key(served.result) === key(fresh.result) &&
    served.movedContext === fresh.movedContext &&
    served.movedScope === fresh.movedScope
  )
    return;
  throw new InternalCompilerError(
    `walk memo entry does not match a fresh mapping: type ` +
      `${checkerTypeDescription(type, ctx)} answered ${key(served.result)} from the memo ` +
      `(context ${served.movedContext}, scope ${served.movedScope}) and ${key(fresh.result)} ` +
      `when mapped again (context ${fresh.movedContext}, scope ${fresh.movedScope})`,
  );
}

export const walkRefusals = [0, 0, 0, 0, 0, 0];

export let walkFrames = 0;

export let walkLongest = 0;

export let walkLongestRoot = "";


export function walkEnded(walk: TypeWalk, ctx: TypeMapperCtx): void {
  walkFrames += walk.clock;
  if (walk.clock <= walkLongest) return;
  walkLongest = walk.clock;
  walkLongestRoot =
    (walk.root === null ? "?" : ctx.checker.typeToString(walk.root)) +
    (walk.rootLenient ? ", lenient" : "");
}


export function walkLeave(frame: ProgressFrame | null): void {
  const walk = activeWalk;
  if (frame === null || walk === null) return;
  const table = walk.active[frame.kind]!;
  if (table.get(frame.key) !== frame) return;
  if (frame.outer !== undefined) {
    table.set(frame.key, frame.outer);
    return;
  }
  table.delete(frame.key);
  if (frame.earlier !== undefined) {
    frame.earlier.push(frame.start);
    const at = walk.reentered.lastIndexOf(frame);
    if (at >= 0) walk.reentered.splice(at, 1);
  } else {
    walk.finished[frame.kind]!.set(frame.key, [frame.start]);
  }
}
