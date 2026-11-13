// Statement slice of the former frontend/type-mapper.ts (split for
// maintainability; the directory barrel ../type-mapper.ts re-exports the
// original public surface). Statements are verbatim from the original file.
import { InternalCompilerError } from "../../errors.js";
import { arrayOf, BIGINT_T, BOOL, DYN, F64, FOREIGN, isSupportedArrayElem, primitiveConstructorType, RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, RUNTIME_STREAM_CLASSES, sortArms, STRING, SYMBOL_T, typeEquals, typeKey, VOID } from "../../ir/ir.js";
import type { IrType } from "../../ir/ir.js";
import { isJsSourceFile } from "../program.js";
import { isProvenanceSourceFile } from "../provenance-registry.js";
import * as ts from "../ts7/adapter.js";
import { PARSE_ARGS_DYN_TYPES } from "./s00.js";
import { checkerTypeDescription } from "./s02.js";
import { isDeclaredInAmbientModule, isWebAssemblyType, provenanceOf } from "./s04.js";
import { MAP_TYPE_MAX_DEPTH } from "./s05.js";
import type { TypeMapperCtx } from "./s05.js";
import { TYPE_WALK_STEP_LIMIT, TypeWalk, WalkDep, WalkEntry, idleWalk, progressStarts, verifySharedTypeMemo, verifyWalkEntry, walkEnded, walkEntriesVerified, walkEntrySpans, walkFrames, walkLongest, walkLongestRoot, walkOverLimit, walkPassedLimit, walkRefusals } from "./s07.js";
import { depthEntryKey, isFetchBodyUnion, isLegacyUrlType, isLookupOptionsUnion, isModuleConstantsType, isOsConstantsType, isPathPlatformNamespaceId, isPlatformPathType, walkEntryServes } from "./s08.js";
import { BUILTIN_HANDLE_KINDS, isDynInterfaceSubset, isEventsIteratorResult, isFetchHeadersUnion, isReceiveMessageResult } from "./s09.js";
import { arrayClassBaseType, classExprNeedsContext, constructorFunctionMappings, mapType, noteConstructorFunctionMemo, noteConstructorFunctionType, spreadsCheckedDynamic } from "./s10.js";
import { mapTypeInnerPart2 } from "./s11.js";
import { holdsUntypedConstructor, primitiveConstructorResult } from "./s17.js";
import { mapBoundIndexedAccess, mapClassView, mapNarrowedTypeParam } from "./s19.js";
import { mapBoundSignatureAlias, mapGenericAwaitedAlias, mapGenericIndexedAccess } from "./s20.js";
import { evalMappedTemplate, mapBoundKeyofNeverConditional, mapDistributedConditional, pinnedBindingsCtx } from "./s21.js";
import { readonlyClassType, unitOnlyUnion } from "./s22.js";
import { isUnitOnlyTsType, mapClassExpandoIntersection } from "./s23.js";
import { immutableSourceType, mapErrorMetadataIntersection, noInferSourceType, packageDeclarations, packageTypeIsData, purePackageDeclarations } from "./s24.js";
import { ERASURE_KEPT_CONTAINERS, mentionsErasedTypeParam } from "./s25.js";


export let mapTypeDepth = 0;

/** Bumped whenever mapType resolves a type through CONTEXT-SENSITIVE or
 * collection-sensitive hooks (a generic body's type parameter, a mixin
 * instantiation, a generic class instance) — mappings that can make the same
 * ts.Type answer differently across instantiation contexts or collection
 * phases.
 * The recursive-shape machinery keys shape identity by checker type, which
 * is sound only for context-FREE mappings: a recursive frame that observes
 * a bump between entry and exit stays fenced (recursive generic-open types
 * stay fenced instead of interning a per-context-wrong shape). */
export let contextResolutions = 0;


/** Bumped whenever a mapping reads state that only a generic-INSTANTIATION
 * scope installs: a type-parameter binding (the Lowerer's resolver hooks,
 * consulted whether or not bindings are installed right now — the same
 * checker type parameter answers differently with and without them), the
 * instance's result class, or the local-class instantiation stack. The
 * answer of such a mapping can differ from one instance to the next, so it
 * stays in that scope's memo (Lowerer.currentTypeMemo). A mapping that reads
 * none of it is the answer every scope gives, and may serve all of them
 * (TypeMapperCtx.typeMemoShared). */
export let scopeSensitivity = 0;


/** Notes that the mapping in progress read generic-instantiation scope state. */
export function noteScopeSensitiveMapping(): void {
  scopeSensitivity++;
}

export let verifiedSharedHits = 0;

/** Set while verifying, so the recomputation bypasses every memo and does
 * not verify itself. */
export let bypassTypeMemo = false;


// ---------------------------------------------------------------------------
// The walk memo: one mapping maps each type it reaches once.
//
// The memos above hold the answer of a whole mapping (the type mapType was
// called with). The types that mapping reaches on the way are mapped by
// nested frames, and a nested frame's answer is not a function of its type
// alone, so it cannot enter those memos. Without a memo of its own, though, a
// mapping walks a nested type once for every path that reaches it: a chain of
// records that each name the next one in two members costs 2^depth.
//
// A nested frame's answer is a function of:
//  - the type, the context object it is mapped under (the mode: strict or
//    lenient, an erased signature, an instantiation's resolvers) and the
//    binding scope (typeMemoFor), which key an entry;
//  - which of the types it reaches are being mapped right now. A record or
//    union met while its own mapping is in progress answers a recursive
//    placeholder instead of being mapped (the knot), so the same type maps
//    differently below different ancestors. An entry lists the in-progress
//    types its frame answered from and serves only while each of them is in
//    progress again or has become the finished recursive type the placeholder
//    named; and it does not serve below a type that the frame itself mapped
//    in full, where mapping again would meet that type in progress;
//  - the recursive placeholders the registries hold: one minted or finished
//    for a type changes how that type maps from then on, so entries that hold
//    an earlier answer of it are dropped;
//  - how deep the frame sat when its walk met MAP_TYPE_MAX_DEPTH;
//  - the key-order rank the shapes it interned were offered under.
// What a frame does besides answering (the context and scope counters it
// moves) is replayed when its entry serves.
//
// The memo lives for one top-level mapType call, or for a withTypeWalk scope
// that makes several of them one walk. Nothing in it outlives the lowerer
// state it was computed under, and that includes the type memos above: a
// top-level mapping that succeeds writes its answer there, the nested frames
// of the next mapping read it, and an answer computed before the write is
// not the one a mapping gives after it (a type that met MAP_TYPE_MAX_DEPTH
// maps once a part of it is in the memo). So only mappings that keep nothing
// in the type memos share a walk, and a write inside a walk drops its
// entries.
// ---------------------------------------------------------------------------

/** SCRIPTC_TYPE_WALK_MEMO=0 maps without the walk memo (and without the step
 * limit), as every mapping did before it: for comparisons. `=verify` maps
 * again each time an entry serves and fails when the two answers differ: it
 * proves on a corpus that the memo changes no mapping. `=stats` counts. */
export const walkMemoMode = process.env["SCRIPTC_TYPE_WALK_MEMO"] ?? "";

export let walkMemoEnabled = walkMemoMode !== "0";

export let walkMemoVerify = walkMemoMode === "verify";

export let walkStepLimit = ((): number => {
  const text = process.env["SCRIPTC_TYPE_WALK_STEPS"];
  const parsed = text === undefined ? NaN : Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : TYPE_WALK_STEP_LIMIT;
})();


/** Sets how type walks run from now on and answers the settings replaced:
 * for tests and measurements, which compare a mapping with the memo, without
 * it and with every served entry verified, or lower the step limit to see
 * SC2016. Not while a mapping is in progress. */
export function configureTypeWalk(settings: { memo?: "on" | "off" | "verify"; steps?: number }): {
  memo: "on" | "off" | "verify";
  steps: number;
} {
  const previous = {
    steps: walkStepLimit,
    memo: !walkMemoEnabled
      ? ("off" as const)
      : walkMemoVerify
        ? ("verify" as const)
        : ("on" as const),
  };
  if (mapTypeDepth !== 0 || activeWalk !== null)
    throw new InternalCompilerError("configureTypeWalk during a type mapping");
  if (settings.memo !== undefined) {
    walkMemoEnabled = settings.memo !== "off";
    walkMemoVerify = settings.memo === "verify";
  }
  if (settings.steps !== undefined) walkStepLimit = settings.steps;
  idleWalk.reset();
  idleWalk.root = null;
  return previous;
}


/** The walk in progress: from a top-level mapType call to its return, or a
 * withTypeWalk scope. */
export let activeWalk: TypeWalk | null = null;

/** What the frame being computed has gathered for its entry: the frames in
 * progress it answered from, the spans of the entries that served inside it
 * ([from, to] pairs, unsorted), and the deepest frame below it. A frame saves
 * its parent's, starts its own, and folds its own into the parent's when it
 * ends. */
export let frameDeps: Set<WalkDep> | null = null;

export let frameSpans: number[] | null = null;

export let frameDeepest = 0;

/** Bumped whenever a mapping is refused for MAP_TYPE_MAX_DEPTH: a frame that
 * saw it move answers for its own depth only. */
export let depthLimitHits = 0;

export let walkEntriesServed = 0;

/** SCRIPTC_TYPE_WALK_MEMO=stats: why entries that were found did not serve
 * (stale, depth, erasure, rank, dependency, re-entered), the frames all
 * walks computed, and the longest walk. */
export const walkStats = walkMemoMode === "stats";

if (walkStats || walkMemoVerify) {
  process.on("exit", () => {
    process.stderr.write(
      `[type-walk] ${walkEntriesServed} entries served, ${walkEntriesVerified} verified, ` +
        `${walkFrames} frames, longest walk ${walkLongest} (${walkLongestRoot}), entries not ` +
        `served: stale ${walkRefusals[0]}, depth ${walkRefusals[1]}, erasure ${walkRefusals[2]}, ` +
        `rank ${walkRefusals[3]}, dependency ${walkRefusals[4]}, re-entered ${walkRefusals[5]}\n`,
    );
  });
}


/** Runs `fn` with every top-level mapping inside it sharing one walk memo:
 * a mapping that asks mapType once per component (the canonical form asks
 * for each object node) maps each type it reaches once. Only under a context
 * that keeps nothing in the type memos (canMemoizeType answers false; see
 * above), and only for a stretch that leaves the lowerer's state alone (no
 * binding scope entered or left, nothing degraded, no collection phase
 * ended): the memo's answers are the ones that state gives. */
export function withTypeWalk<T>(root: ts.Type, ctx: TypeMapperCtx, fn: () => T): T {
  if (activeWalk !== null || !walkMemoEnabled || mapTypeDepth !== 0) return fn();
  if (ctx.canMemoizeType?.() ?? true) return fn();
  if (walkOverLimit !== null) throw walkOverLimit;
  const walk = idleWalk;
  walk.reset();
  walk.root = root;
  walk.rootLenient = ctx.lenient === true;
  activeWalk = walk;
  try {
    return fn();
  } finally {
    activeWalk = null;
    if (walkStats) walkEnded(walk, ctx);
  }
}


/** The frame being computed answered from a mapping in progress: a recursive
 * placeholder (`strict` false), or a rule that reads "in progress" itself. */
export function walkBackReference(kind: number, key: ts.Type | ts.Symbol, strict: boolean): void {
  const walk = activeWalk;
  if (walk === null) return;
  const frame = walk.active[kind]!.get(key);
  // In progress since before the walk: so for all of it.
  if (frame === undefined) return;
  if (frameDeps === null) frameDeps = new Set();
  frameDeps.add(strict ? frame.strictDep : frame.dep);
}


/** Folds an entry that serves into the frame being computed, as mapping the
 * type again would have: the counters it moved, the frames in progress it
 * answered from, its span and its depth. */
export function walkEntryTaken(walk: TypeWalk, entry: WalkEntry, depth: number): void {
  walkEntriesServed++;
  if (entry.movedContext) contextResolutions++;
  if (entry.movedScope) scopeSensitivity++;
  if (entry.metDepthLimit) depthLimitHits++;
  const spans = (frameSpans ??= []);
  for (const bound of entry.spans) spans.push(bound);
  if (depth + entry.height > frameDeepest) frameDeepest = depth + entry.height;
  const deps = entry.deps;
  if (deps === null) return;
  for (const dep of deps) {
    const now = walk.active[dep.frame.kind]!.get(dep.frame.key);
    if (now === undefined) continue;
    if (frameDeps === null) frameDeps = new Set();
    frameDeps.add(dep.strict ? now.strictDep : now.dep);
  }
}


export function mapTypeEntry(type: ts.Type, ctx: TypeMapperCtx): IrType | null {
  if (mapTypeDepth >= MAP_TYPE_MAX_DEPTH) {
    depthLimitHits++;
    return null;
  }
  // These intrinsic domains cannot depend on generic bindings, declaration
  // provenance, or recursive shape state. Enum literals retain the ordinary
  // widening path, including mixed numeric/string enum representations.
  const flags = type.flags;
  if ((flags & ts.TypeFlags.EnumLike) === 0) {
    if (flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) return F64;
    if (flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral | ts.TypeFlags.TemplateLiteral))
      return STRING;
    if (flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) return BOOL;
  }
  if (ctx.foreignType !== undefined && ctx.foreignType(type)) return FOREIGN;
  const localValue = ctx.localClassValue?.(type);
  if (localValue) {
    contextResolutions++;
    return localValue;
  }
  const topLevel = mapTypeDepth === 0;
  const typeId = (type as { id?: number }).id;
  const memoizable = typeId !== undefined && (ctx.canMemoizeType?.() ?? true);
  // An empty literal's type maps to the empty record as an unreduced union's
  // arm (emptyLiteralArm) and to the checked-dynamic value elsewhere: the two
  // answers keep separate memo entries. Type ids are non-negative integers.
  const memoKey = memoizable ? typeId * 2 + (ctx.emptyLiteralArm ? 1 : 0) : null;
  /** The memo of the binding context this frame started in: the scope's own
   * inside generic bindings, the lowerer's top-level memo outside them. */
  let contextMemo: Map<number, IrType> | undefined;
  if (memoKey !== null && !bypassTypeMemo) {
    contextMemo = ctx.typeMemoFor?.() ?? ctx.typeMemo;
    const own = contextMemo?.get(memoKey);
    if (own !== undefined) {
      // The scope's own memo also holds answers this scope's bindings shaped
      // (they were written here, not shared). Taking one re-reads that
      // scope state just as mapping the type would, so the frame that took it
      // is scope-specific too: without this the parent could enter the shared
      // memo and serve this instance's representation to every later one.
      if (ctx.typeMemoShared?.get(memoKey) !== own) noteScopeSensitiveMapping();
      noteConstructorFunctionMemo(ctx, memoKey);
      return own;
    }
    const shared = ctx.typeMemoShared;
    if (shared !== undefined && shared !== contextMemo) {
      const hit = shared.get(memoKey);
      if (hit !== undefined) {
        if (verifySharedTypeMemo && topLevel) verifySharedMapping(type, ctx, hit);
        noteConstructorFunctionMemo(ctx, memoKey);
        return hit;
      }
    }
  }
  const sensitivityAtEntry = contextResolutions;
  const scopeReadsAtEntry = scopeSensitivity;
  const constructorMappingsAtEntry = constructorFunctionMappings;
  const depth = mapTypeDepth;
  // The walk this frame belongs to: a top-level frame outside a withTypeWalk
  // scope starts one, and has no entry to look for or to leave.
  let walk = activeWalk;
  let startsWalk = false;
  if (walk === null && walkMemoEnabled && topLevel) {
    if (walkOverLimit !== null) throw walkOverLimit;
    idleWalk.reset();
    walk = activeWalk = idleWalk;
    startsWalk = true;
  }
  let entries: Map<number, WalkEntry> | null = null;
  let walkKey = 0;
  let walkScope: unknown = undefined;
  let served: WalkEntry | undefined;
  const walkMemoizable =
    walk !== null &&
    typeId !== undefined &&
    !walk.opaque &&
    !bypassTypeMemo &&
    (ctx.canMemoizeWalk?.() ?? ctx.canMemoizeType?.() ?? true);
  if (walkMemoizable) {
    walkScope = contextMemo ?? ctx.typeMemoFor?.() ?? ctx.typeMemo;
    // A lenient mapping answers the checked dynamic for a nested type that
    // does not map and "does not map" for the top-level one.
    walkKey =
      typeId * 4 + (ctx.emptyLiteralArm ? 1 : 0) + (topLevel && ctx.lenient === true ? 2 : 0);
    if (startsWalk) {
      // Nothing to look for yet.
      walk!.root = type;
      walk!.rootLenient = ctx.lenient === true;
    } else {
      entries = walk!.entriesFor(ctx, walkScope);
      const entry = entries.get(walkKey);
      if (entry !== undefined && walkEntryServes(walk!, entry, depth, ctx)) served = entry;
      else {
        const atDepth = entries.get(depthEntryKey(walkKey, depth));
        if (atDepth !== undefined && walkEntryServes(walk!, atDepth, depth, ctx)) served = atDepth;
      }
    }
  }
  let mapped: IrType | null = null;
  if (served !== undefined && !walkMemoVerify) {
    walkEntryTaken(walk!, served, depth);
    mapped = served.result;
  } else {
    const parentDeps = frameDeps;
    const parentSpans = frameSpans;
    const parentDeepest = frameDeepest;
    const limitHitsAtEntry = depthLimitHits;
    const progressAtEntry = progressStarts;
    const outerConsulted = ctx.erasedMember?.outerConsulted ?? false;
    let started = 0;
    let recordable = false;
    mapTypeDepth++;
    try {
      let refused = false;
      try {
        if (walk !== null) {
          started = ++walk.clock;
          frameDeps = null;
          frameSpans = null;
          frameDeepest = depth;
          if (started + walk.refused > walkStepLimit) throw walkPassedLimit(walk, type, ctx);
        }
        mapped = mapTypeInner(type, ctx);
      } catch (e) {
        // typescript-go's API can panic serializing a union's members (an
        // empty tuple cloned as an array literal, `s.match(re) || []`): a
        // union the checker cannot describe has no representation.
        if (!topLevel || !ts.isUnreadableConstituentsPanic(e)) throw e;
        mapped = null;
        refused = true;
      }
      // A generic alias the body spells over its own type parameters (`x as
      // Catalog<G, P>`) stays symbolic in the checker; when that form does not
      // map, the instance's concrete instantiation of the same alias does.
      if (mapped === null && ctx.resolveBoundAliasTs) {
        const concrete = ctx.resolveBoundAliasTs(type);
        if (concrete !== null && concrete !== type) {
          mapped = mapType(concrete, ctx);
          if (mapped !== null) contextResolutions++;
        }
      }
      // A PACKAGE DATA SHAPE the structural rules cannot map: `import type`
      // from a package whose implementation is not part of the compiled
      // module graph declares data the program itself builds, and a
      // declaration the compiled graph never loads cannot produce a value of
      // its own. A shape with no native mapping is then exactly the
      // checked-dynamic value — the same answer `unknown` gets — never the
      // package's story (there is no package value here to disagree with).
      //
      // The fallback reads the type's declarations and nothing of the binding
      // context, so it is not a context resolution of its own: when the
      // structural attempt consulted the context, that read counted itself,
      // and when it did not, the type has this answer wherever it is mapped.
      // Counting it kept every type that holds such a shape out of the memo:
      // an SDK configuration type whose answer is the checked-dynamic value
      // was mapped from scratch at each of its uses (pi's
      // `BedrockRuntimeClientConfig`: forty mappings of half a second each in
      // one function).
      if (mapped === null && packageTypeIsData(type, ctx)) mapped = DYN;
      // Localized failure: a type that failed at a committed slot maps to its
      // lenient form. It counts as a context resolution so neither it nor a
      // type containing it is memoized: the strict form may map elsewhere.
      if (mapped === null && ctx.degradedType) {
        const lenient = ctx.degradedType(type);
        if (lenient !== null) {
          mapped = lenient;
          contextResolutions++;
        }
      }
      // Push-down (stage L3): in a lenient mapping, the smallest failing
      // component is the checked dynamic.
      if (mapped === null && ctx.lenient === true && !topLevel) {
        mapped = DYN;
        contextResolutions++;
        ctx.onLenientPiece?.(type);
      }
      recordable = !refused;
    } finally {
      mapTypeDepth--;
      if (walk !== null && started !== 0) {
        // What the frame answered from that started before it: its entry
        // depends on those, and so does its parent's.
        let deps: WalkDep[] | null = null;
        if (frameDeps !== null)
          for (const dep of frameDeps) if (dep.frame.start < started) (deps ??= []).push(dep);
        const spans = walkEntrySpans(frameSpans, started, walk.clock);
        const deepest = frameDeepest;
        frameDeps = parentDeps;
        if (deps !== null) {
          frameDeps ??= new Set();
          for (const dep of deps) frameDeps.add(dep);
        }
        // The parent's own span covers this frame's; what served in here
        // from before the parent started is the parent's to keep.
        frameSpans = parentSpans;
        if (spans.length > 2) {
          frameSpans ??= [];
          for (let i = 0; i < spans.length - 2; i++) frameSpans.push(spans[i]!);
        }
        frameDeepest = deepest > parentDeepest ? deepest : parentDeepest;
        if (walkMemoizable) {
          // Only a frame that mapped a record, a union or an overload set
          // below it is worth an entry; the others are one step to repeat.
          // (Verifying, every frame an entry was about to answer for is
          // compared with it.)
          if (recordable && (progressStarts !== progressAtEntry || served !== undefined)) {
            entries ??= walk.entriesFor(ctx, walkScope);
            const entry = new WalkEntry(
              mapped,
              contextResolutions !== sensitivityAtEntry,
              scopeSensitivity !== scopeReadsAtEntry,
              deps,
              spans,
              depth,
              deepest - depth,
              depthLimitHits !== limitHitsAtEntry,
              ctx.shapes.declaredOrderRank(),
              outerConsulted,
            );
            if (served !== undefined) verifyWalkEntry(type, ctx, served, entry);
            // An answer that met the depth limit is the answer at this depth
            // only, and the same type is mapped at several depths (a member's
            // type directly and as a union's arm): one entry per depth.
            entries.set(entry.metDepthLimit ? depthEntryKey(walkKey, depth) : walkKey, entry);
          }
        }
      }
      if (startsWalk) {
        activeWalk = null;
        if (walkStats) walkEnded(walk!, ctx);
      }
    }
  }
  if (
    mapped !== null &&
    memoKey !== null &&
    topLevel &&
    !bypassTypeMemo &&
    contextResolutions === sensitivityAtEntry &&
    ctx.erasingSignature === undefined &&
    (ctx.canMemoizeType?.() ?? true)
  ) {
    // Read the hook again rather than reusing the entry's memo: the write
    // condition rechecks the binding context, and a hook is what keeps a
    // context copy made inside a binding scope pointed at that scope.
    const liveMemo = ctx.typeMemoFor?.() ?? ctx.typeMemo;
    // A scope that changed mid-frame cannot own this answer. (It cannot
    // happen today; the identity check keeps it a proof rather than an
    // assumption.)
    if (liveMemo === contextMemo) {
      // The walk this frame is part of (a top-level frame that started its
      // own has ended it) computed its entries without this answer.
      if (activeWalk !== null) activeWalk.staleBefore = activeWalk.clock;
      liveMemo?.set(memoKey, mapped);
      if (constructorFunctionMappings !== constructorMappingsAtEntry)
        ctx.constructorFunctionMemo?.add(memoKey);
      // An answer that read no scope state is every scope's answer, so it
      // also serves the shared memo — including the scopes entered later.
      const shared = ctx.typeMemoShared;
      if (shared !== undefined && shared !== liveMemo && scopeSensitivity === scopeReadsAtEntry)
        shared.set(memoKey, mapped);
    }
  }
  return mapped;
}


/** SCRIPTC_TYPE_MEMO_VERIFY: recomputes a shared memo entry in the scope
 * that just took it and fails loudly when the two answers disagree. The
 * recalculation runs with every memo bypassed and restores the mapping
 * counters it moves, so the observation leaves the mapping it observes
 * unchanged. */
export function verifySharedMapping(type: ts.Type, ctx: TypeMapperCtx, shared: IrType): void {
  const resolutions = contextResolutions;
  const scopeReads = scopeSensitivity;
  bypassTypeMemo = true;
  let recomputed: IrType | null;
  try {
    recomputed = mapTypeEntry(type, ctx);
  } finally {
    bypassTypeMemo = false;
    contextResolutions = resolutions;
    scopeSensitivity = scopeReads;
  }
  const wanted = recomputed === null ? "<unmapped>" : typeKey(recomputed);
  verifiedSharedHits++;
  if (typeKey(shared) === wanted) return;
  throw new InternalCompilerError(
    `shared type memo entry does not match a fresh mapping: type ` +
      `${checkerTypeDescription(type, ctx)} answered ${typeKey(shared)} from the shared ` +
      `memo and ${wanted} when remapped in its scope`,
  );
}


export function mapTypeInner(type: ts.Type, ctx: TypeMapperCtx): IrType | null {

  const { checker, unions, classNamer, resolveTypeParam } = ctx;
  // TypeScript's intrinsic globalThis symbol has no declaration. A stored
  // reference needs native object identity, including var's undefined state.
  const intrinsic = type.getSymbol();
  const isIntrinsicGlobal = (symbol: ts.Symbol | undefined): boolean =>
    symbol !== undefined &&
    ts.symbolName(symbol) === "globalThis" &&
    symbol.declarations.length === 0;
  if (isIntrinsicGlobal(intrinsic)) return DYN;
  // `typeof globalThis & { key?: T }` (the global-singleton spelling) is the
  // same global object with declared extra members.
  if (
    type.isIntersectionType() &&
    ts.constituentTypes(type).some((part) => isIntrinsicGlobal(part.getSymbol()))
  )
    return DYN;
  if (ctx.jsDynamicDeclaration !== undefined && intrinsic !== undefined) {
    const objectLiteral = (intrinsic.flags & ts.SymbolFlags.ObjectLiteral) !== 0;
    const classInstance =
      (intrinsic.flags & ts.SymbolFlags.Class) !== 0 && type.isClassOrInterface();
    if (
      (objectLiteral || classInstance) &&
      intrinsic.declarations.some((decl) => ctx.jsDynamicDeclaration!(decl))
    )
      return DYN;
  }
  {
    const moduleId = ctx.moduleNamespaceId?.(type) ?? null;
    // node:path's platform namespaces (`path.posix`, `path.win32`) are
    // ordinary objects at run time: the same module object the whole
    // namespace lowers to (pathModuleValue). Typing them as a module
    // namespace declaration made every value read a static type with no
    // value lowering; the checked-dynamic module value is the honest
    // type, and a union with a plain record arm collapses onto it.
    if (moduleId !== null && !isPathPlatformNamespaceId(moduleId))
      return { kind: "moduleNs", moduleId };
    if (moduleId !== null) return DYN;
  }
  // A TypeScript object literal that spreads a checked-dynamic value
  // (`{ ...requestOptions, path, timeout }`): its keys are the source's
  // runtime keys, which no record shape holds, so the literal rides
  // checked-dynamic storage like its source.
  if (spreadsCheckedDynamic(intrinsic, ctx)) return DYN;
  // worker_threads.receiveMessageOnPort's `{ message: any } | undefined`:
  // the runtime's { message } object, a checked-dynamic value.
  if (isReceiveMessageResult(type, ctx)) return DYN;
  // events.on's iterator result: the runtime's { value, done } object.
  if (isEventsIteratorResult(type, ctx)) return DYN;
  if (isFetchBodyUnion(type, ctx) || isFetchHeadersUnion(type, ctx)) return DYN;
  // Omit/Pick/Partial of a stdlib interface that rides checked-dynamic
  // storage (`Omit<RequestInit, "body" | "headers">`): every member comes
  // from that interface, so the value is a subset of the same runtime-read
  // options object and rides the same storage.
  if (isDynInterfaceSubset(type, ctx)) return DYN;
  // The lookup-function option union (`LookupOneOptions | LookupAllOptions
  // | number | undefined`): with a LookupAllOptions arm it is an option bag
  // dns.lookup reads at run time, so it rides checked-dynamic storage.
  if (isLookupOptionsUnion(type, ctx)) return DYN;
  // @types/node spells child_process.ExecFileException as an intersection
  // type alias over two Error-derived metadata interfaces. The value is
  // still one ordinary Error; recognize the owned alias before generic
  // intersection mapping decomposes it into unsupported utility types.
  const directAlias = type.getAliasSymbol();
  if (
    directAlias !== undefined &&
    ts.symbolName(directAlias) === "ExecFileException" &&
    directAlias.declarations.some((decl) => ctx.isStdlibFile(ts.getSourceFileOfNode(decl)))
  ) {
    return { kind: "object", className: "%Error" };
  }
  // child_process.ExecException, exec's callback error, is an interface
  // extending Error with optional metadata members; the value is one
  // ordinary Error as well.
  const execException = type.getSymbol();
  if (
    execException !== undefined &&
    ts.symbolName(execException) === "ExecException" &&
    execException.declarations.some(
      (decl) =>
        ts.isInterfaceDeclaration(decl) &&
        ctx.isStdlibFile(ts.getSourceFileOfNode(decl)) &&
        isDeclaredInAmbientModule(decl, "child_process"),
    )
  ) {
    return { kind: "object", className: "%Error" };
  }
  // @types/node declares the platform-path namespace value as the
  // `PlatformPath` interface of module "path"; its values ARE the path
  // module object (the checked-dynamic module value).
  if (isPlatformPathType(type, ctx)) return DYN;
  if (isOsConstantsType(type, ctx) || isLegacyUrlType(type, ctx)) return DYN;
  if (isModuleConstantsType(type, ctx)) return DYN;
  // The WebAssembly API's values have the checked-dynamic representation, so
  // declarations that merely mention them compile; each reached use of the
  // API itself is refused at its site (builtins/webassembly.ts).
  if (isWebAssemblyType(type, ctx)) return DYN;
  // A union over one of them (quickjs-wasi's `BufferSource | WebAssembly.Module`
  // option) holds that dynamic value too, so the whole union is dynamic.
  if (type.isUnionType() && ts.constituentTypes(type).some((t) => isWebAssemblyType(t, ctx)))
    return DYN;
  // JavaScript inference merges WebAssembly.instantiate's overloads into
  // `Promise<WebAssemblyInstantiatedSource> & Promise<Instance>`: a promise
  // of a WebAssembly value either way.
  if (
    type.isIntersectionType() &&
    ts.constituentTypes(type).every((t) => {
      if (ts.symbolNameOf(t.getSymbol()) !== "Promise") return false;
      const arg = ctx.checker.getTypeArguments(t as ts.TypeReference)[0];
      return arg !== undefined && isWebAssemblyType(arg, ctx);
    })
  )
    return { kind: "promise", inner: DYN };
  // Immutable<T> (@scriptc/types) is a deep-readonly view: the value is
  // still the T it maps.
  const immutableSource = immutableSourceType(type, ctx);
  if (immutableSource !== null) return mapType(immutableSource, ctx);
  // NoInfer<T> only keeps a position out of type-argument inference: its
  // values are T's.
  const noInferSource = noInferSourceType(type);
  if (noInferSource !== null) return mapType(noInferSource, ctx);
  // Inside an erased generic signature or body, every type that mentions
  // an erased type parameter is `unknown` (`T[]`, `Map<string, T>`,
  // `[A, B]`, `T[K]`, callbacks over `T`): its values cross through the
  // checked-dynamic boundary, as JavaScript sees them. The erased
  // signature itself maps its parameters and result this way.
  if (
    (ctx.erasingSignature || ctx.isErasing?.()) &&
    !(type.flags & ts.TypeFlags.TypeParameter) &&
    !checker.getCallSignatures(type).some((sig) => sig === ctx.erasingSignature) &&
    !ERASURE_KEPT_CONTAINERS.has(ts.symbolNameOf(type.getSymbol()) ?? "") &&
    mentionsErasedTypeParam(type, ctx, 0)
  ) {
    if (!ctx.erasedMember || ctx.erasedMember.outerConsulted) contextResolutions++;
    return DYN;
  }
  // Readonly<C> over a program class (Object.freeze's result type) is the
  // same instance.
  const readonlyClass = readonlyClassType(type, ctx);
  if (readonlyClass !== null) return readonlyClass;
  if (resolveTypeParam && type.flags & ts.TypeFlags.TypeParameter) {
    const bound = resolveTypeParam(type);
    if (bound) {
      if (!ctx.erasedMember?.own.has(type)) contextResolutions++;
      return bound;
    }
  }
  // Narrowed type parameters: `!== undefined` / `!== null` / truthiness on
  // a `T | undefined`-flavored value inside a generic body leaves the
  // SYMBOLIC forms `T & {}`, `T & ({} | null)`, `(T & {}) | (T & null)`
  // (concrete types compute the intersection away; only generic bodies see
  // them). Each companion is an ALLOWANCE over the binding's arms — `{}`
  // admits every non-unit arm, a null/undefined companion its unit — and
  // the mapping is the binding filtered to what the narrowing kept.
  if (resolveTypeParam) {
    const viaNarrowedParam = mapNarrowedTypeParam(type, ctx);
    if (viaNarrowedParam !== undefined) {
      contextResolutions++;
      return viaNarrowedParam;
    }
    // `Awaited<T>` over a bound type parameter (an async generic body's
    // `await fn()` result): a CONDITIONAL type the checker keeps symbolic
    // inside the body — the object-gated utility-alias hook below never
    // sees it, so it resolves here, before the flag dispatch.
    const viaAwaited = mapGenericAwaitedAlias(type, ctx);
    if (viaAwaited !== null) {
      contextResolutions++;
      return viaAwaited;
    }
    // `T[K]` over a bound parameter: like Awaited, a form the checker
    // keeps symbolic inside the body. Two resolvers, tried in order: the
    // structural read against the record binding, then the bound-checker
    // route for a K naming one concrete key (mapBoundIndexedAccess).
    const viaIndexed = mapGenericIndexedAccess(type, ctx) ?? mapBoundIndexedAccess(type, ctx);
    if (viaIndexed !== null) {
      contextResolutions++;
      return viaIndexed;
    }
    // `Parameters<F>` / `ReturnType<F>` over a bound function-typed
    // parameter (variadic higher-order wrappers): the checker keeps both
    // conditionals symbolic inside the body, and their `infer` positions
    // match a call signature, which matchInferReference cannot decide.
    const viaSignature =
      mapBoundSignatureAlias(type, ctx) ?? mapBoundKeyofNeverConditional(type, ctx);
    if (viaSignature !== null) {
      contextResolutions++;
      return viaSignature;
    }
    // A conditional type over a bound parameter (`Infer<S["left"]>`, a
    // mapped type's member): evaluate it against the bindings.
    if (type.isConditionalType()) {
      const evaluated = evalMappedTemplate(type, new Map(), new Map(), ctx);
      if (evaluated && evaluated !== type) {
        const viaConditional = mapType(evaluated, ctx);
        if (viaConditional !== null) {
          contextResolutions++;
          return viaConditional;
        }
      }
      const viaDistribution = mapDistributedConditional(type, ctx);
      if (viaDistribution !== null) {
        contextResolutions++;
        return viaDistribution;
      }
      // One distributed member of `Extract<U, { k: T }>`, whose branch the
      // literal this instance is keyed on decides (memberPatternExtendsCheck).
      const pinned = pinnedBindingsCtx(ctx);
      const selected = pinned ? evalMappedTemplate(type, new Map(), new Map(), pinned) : null;
      if (selected && selected !== type) {
        const viaPattern = mapType(selected, ctx);
        if (viaPattern !== null) {
          contextResolutions++;
          return viaPattern;
        }
      }
    }
  }
  const widened = checker.getBaseTypeOfLiteralType(type);
  const flags = widened.flags;
  return mapTypeInnerPart1(ctx, type, checker, classNamer, resolveTypeParam, unions, widened, flags);
}
export function mapTypeInnerPart1(ctx, type, checker, classNamer, resolveTypeParam, unions, widened, flags): IrType | null {


  if (flags & ts.TypeFlags.Number) return F64;
  if (flags & ts.TypeFlags.String) return STRING;
  if (flags & ts.TypeFlags.Boolean || flags & ts.TypeFlags.BooleanLiteral) return BOOL;
  // ErrorOptions carries a presence-sensitive unknown value. A fixed
  // optional field cannot distinguish {} from { cause: undefined }; the
  // checked-dynamic object retains that distinction through forwarding
  // constructors. Only the standard library's interface gets this ABI.
  const errorOptionsSymbol = widened.getSymbol();
  if (
    errorOptionsSymbol !== undefined &&
    ts.symbolName(errorOptionsSymbol) === "ErrorOptions" &&
    errorOptionsSymbol.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
  ) {
    return DYN;
  }
  // node:util.parseArgs config/results are declaration-heavy conditional
  // and discriminated-union types over a value that is naturally a checked-
  // dynamic tree. Keep the named public surface (plus @types/node's private
  // helper aliases that survive instantiation) in that representation:
  // typed member reads still exit through ordinary dyn checks, while the
  // runtime can preserve the three token variants and null-prototype values
  // object without inventing one false static record shape. Provenance keeps
  // user aliases with the same names on the normal structural path.
  {
    const parseArgsSym = widened.getAliasSymbol() ?? widened.getSymbol();
    const belongs = (declaration: ts.Node): boolean => {
      if (!ctx.isStdlibFile(ts.getSourceFileOfNode(declaration))) return false;
      let family = false;
      for (let node: ts.Node | undefined = declaration; node; node = node.parent) {
        if (
          (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
          PARSE_ARGS_DYN_TYPES.has(node.name.text)
        )
          family = true;
        if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
          return family && (node.name.text === "util" || node.name.text === "node:util");
        }
      }
      return false;
    };
    if (
      parseArgsSym &&
      PARSE_ARGS_DYN_TYPES.has(ts.symbolName(parseArgsSym)) &&
      parseArgsSym.declarations.some(belongs)
    )
      return DYN;
    // ReturnType and instantiated conditional types can erase the alias.
    // Require every member to retain the util declaration provenance so
    // unrelated records with similar property names keep their own layout.
    const members = checker.getPropertiesOfType(widened);
    if (members.length > 0 && members.every((member) => member.declarations.some(belongs)))
      return DYN;
  }
  // The lib's BOXED wrapper interfaces used as TYPES (`const n: Number =
  // 5`): every value such a slot can hold IS the primitive — `new
  // Number(...)` construction is fenced, so no box object ever exists —
  // and the interface members are exactly the primitive's lowered surface.
  // Provenance-gated: a user's own `interface Number` maps as a record.
  {
    const boxSym = widened.getSymbol();
    if (
      boxSym &&
      (ts.symbolName(boxSym) === "Number" ||
        ts.symbolName(boxSym) === "String" ||
        ts.symbolName(boxSym) === "Boolean") &&
      boxSym.declarations.some((d) => ctx.isStdlibFile(ts.getSourceFileOfNode(d)))
    ) {
      // Once the program creates wrapper objects, a slot of the boxed type
      // may hold one: the checked-dynamic value holds both.
      if (ctx.primitiveWrappers?.()) return DYN;
      return ts.symbolName(boxSym) === "Number"
        ? F64
        : ts.symbolName(boxSym) === "String"
          ? STRING
          : BOOL;
    }
  }
  // The lib's PRIMITIVE-CONSTRUCTOR interfaces as TYPES (`typeof String`,
  // a `type: StringConstructor` record field — the CLI option-table
  // idiom): the VALUE is the program's one function for the constructor
  // (lower-exprs.ts primitiveCtorClosure), so the type is that function's:
  // it takes whatever arguments its caller passes and answers the
  // constructor's primitive. The result differs per constructor; a union
  // of several of them is one function arm whose result joins theirs (the
  // union rule below). Provenance-gated like the boxed wrappers above: a
  // user's own `interface StringConstructor` maps as a record. Under
  // untypedConstructors the type, and a collection of such values, is the
  // checked-dynamic value.
  if (ctx.untypedConstructors === true && holdsUntypedConstructor(widened, ctx, 4)) return DYN;
  {
    const ctorResult = primitiveConstructorResult(widened, ctx);
    if (ctorResult !== null) {
      noteConstructorFunctionType(ctx);
      return primitiveConstructorType(ctorResult);
    }
  }
  // `symbol` and `unique symbol` (the type of `const k = Symbol(...)` —
  // getBaseTypeOfLiteralType widens unique symbols, but check both flags)
  // map to the symbol identity kind.
  if (flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) return SYMBOL_T;
  if (flags & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) return BIGINT_T;
  // STANDALONE undefined (and void) map to VOID: return-type mapping flows
  // through here, and `(): void | undefined` functions must stay void.
  // Inside a union, undefined becomes the undefinedT unit ARM instead (see
  // the union branch below). VALUE positions that today receive VOID
  // (record fields, tuple/array elements, variable slots) substitute the
  // unit-only union themselves (isUnitOnlyTsType + unitOnlyUnion) — the
  // position knows it wants a value; this mapping cannot.
  if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return VOID;
  // Generic visitors can instantiate `T | undefined` as `void | undefined`.
  // It has the same return convention as standalone void; value positions
  // still substitute the unit-only slot through isUnitOnlyTsType below.
  if (
    widened.isUnionType() &&
    ts.constituentTypes(widened).every((part) => {
      if ((part.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0) return true;
      // A forwarding generic call keeps its caller's symbolic T in the
      // resolved signature. Its current instantiation can still be void.
      if (
        (part.flags & ts.TypeFlags.TypeParameter) !== 0 &&
        resolveTypeParam?.(part)?.kind === "void"
      ) {
        contextResolutions++;
        return true;
      }
      return false;
    })
  )
    return VOID;
  // Standalone `null` (a `const x = null` binding, a `{ value: null }`
  // field, a `(): null` return): the unit-only union — the value is always
  // THE interned null instance, comparisons are tag tests, JSON serializes
  // null. Inside a union, null keeps becoming the nullT ARM (the union
  // branch below never recurses here for null parts).
  if (flags & ts.TypeFlags.Null) return unitOnlyUnion(unions);
  // `never` VALUES are uninhabited — the checker only types dead reads
  // this way (`for (const v of [])`'s loop var, the empty literal's
  // `never[]` element) — so any representation is unobservable; f64 is the
  // cheapest slot. Return positions never reach here (declaredReturnType
  // and the signature branches map never returns to VOID first), and
  // construction sites cannot exist (nothing has type never to feed them).
  if (flags & ts.TypeFlags.Never) return F64;
  // `unknown` is a VALUE with a runtime representation (the dyn JSON dyn —
  // JSON.parse results and unknown-typed locals/params/returns).
  if (flags & ts.TypeFlags.Unknown) return DYN;
  // `object` (the NonPrimitive intrinsic) is a TOP type over non-primitive
  // values — tsc admits every record, array, function, or class instance
  // into an `object` slot, so no exact record shape can hold it. It lowers
  // like `unknown` (the dyn): assignments convert at the site (sources
  // outside the checked-dynamic tree fence there, same as unknown), reads narrow back out
  // through the same checked casts. Member accesses tsc allows on `object`
  // (the Object.prototype surface) fence at their use sites.
  if (flags & ts.TypeFlags.NonPrimitive) return DYN;

  // Context-free `any` has no concrete storage shape. The lowering site
  // chooses checked-value storage when its operations support that boundary.
  if (flags & ts.TypeFlags.Any) return null;
  // Enum types and enum member literal types: an enum VALUE at runtime IS
  // its underlying primitive (tsc's own emit stores plain numbers/strings
  // on the enum object; const enums inline them), so the enum type maps to
  // number/string — comparisons, switch dispatch, arithmetic, and template
  // formatting all take their ordinary primitive lowerings. A member
  // literal type (`E.A` in type position) widens to the whole enum first
  // (getBaseTypeOfLiteralType), so both spellings land here. Heterogeneous
  // enums map to the number|string union (each member READ produces one
  // exact arm; the slot re-tags like any literal-into-union assignment).
  // A union MIXING enum literals with non-enum arms (`E | undefined`)
  // falls through to the general union branch below, whose per-part
  // recursion re-enters here with the pure enum parts.
  if (flags & ts.TypeFlags.EnumLike) {
    const parts = widened.isUnionType() ? ts.constituentTypes(widened) : [widened];
    if (parts.every((p) => p.flags & ts.TypeFlags.EnumLike)) {
      let hasNum = false;
      let hasStr = false;
      for (const p of parts) {
        if (p.flags & ts.TypeFlags.StringLiteral) hasStr = true;
        // NumberLiteral members, and the non-literal `Enum` flavor (an
        // enum with computed members is a NUMERIC enum type — string
        // members would make it a literal enum by definition).
        else hasNum = true;
      }
      if (hasNum && hasStr) {
        const arms = [F64, STRING];
        sortArms(arms);
        return { kind: "union", unionId: unions.intern(arms) };
      }
      return hasStr ? STRING : F64;
    }
  }
  // @scriptc/experimental's LifetimeRegion, InternTable and ThreadSlots:
  // synthetic program classes, provenance-checked by the package's
  // declaration file.
  {
    const classSym = widened.getSymbol();
    const name = ts.symbolNameOf(classSym);
    if (name === "LifetimeRegion" || name === "InternTable" || name === "ThreadSlots") {
      for (const d of classSym!.declarations) {
        if (!ts.isClassDeclaration(d)) continue;
        const synthetic =
          name === "LifetimeRegion"
            ? ctx.lifetimeRegionClass?.(d)
            : name === "InternTable"
              ? ctx.internTableClass?.(d)
              : ctx.threadSlotsClass?.(d);
        if (synthetic) return synthetic;
      }
    }
  }
  // Declaration-only package types have no compiled implementation.
  // Primitive and container types retain their structural mappings; types
  // owned by the standard library or explicit host mappings are handled
  // by their dedicated native rules. Pure type shapes — interfaces, type
  // aliases, object or mapped type literals with no value declaration
  // merged in, and the CALLING-CONVENTION shapes they spell (a function type
  // node, a method signature) — describe data and call signatures, not an
  // implementation: a program value of such a type is one the program built
  // itself (`import type` from a types-only package), so it maps structurally
  // like a local declaration. A callback or method slot is the common case:
  // an SDK config type declares `requestHandler?: (url: string) => void` or
  // `logger?: Logger` with `info(message: string): void`, and the program
  // fills the slot with its own closure. Values the package itself would
  // produce stay refused at their import.
  {
    const aliasDecls = packageDeclarations(widened.getAliasSymbol(), ctx);
    const ownDecls = packageDeclarations(widened.getSymbol(), ctx);
    if (
      (aliasDecls !== null || (widened.getAliasSymbol() === undefined && ownDecls !== null)) &&
      !(purePackageDeclarations(aliasDecls, ctx) && purePackageDeclarations(ownDecls, ctx))
    ) {
      return null;
    }
  }
  // Module namespaces were claimed above when they name compiled source
  // modules or supported builtins. Declaration-only namespaces remain refused.

  // T[]: monomorphic arrays, recursively (number[][] works). An element type
  // that doesn't map (never from a context-free `[]`) makes the whole array
  // unsupported — null propagates. Record/object/union elements ride the
  // runtime's REF element kind (per-array RC entry points, the map-value
  // technique), and PROMISE elements ride it too (Promise<T>[] is
  // Promise.all's food: promises are refcounted, cycle-headered values
  // with `_v` adapters like any other ref element). FUNCTION elements ride REF too (closure
  // `_v` adapters + scr_closure_trace_v — closures are cycle-headered):
  // `f === f` identity through indexOf/includes is sound because a
  // function VALUE is one ScrClosure for its whole life — top-level
  // declarations intern one immortal closure, and inner closures are
  // allocated once at their definition's evaluation and flow by
  // reference, exactly JS's function identity. Maps and Sets use their
  // typed RC/trace adapters; RegExp values use immutable REF storage. URL and
  // Date (scalar-backed but identity-bearing in JS) and the other opaque
  // handles stay unsupported as array elements; ordinary Date locals,
  // params, fixed record/tuple fields, and promise payloads are supported.
  if (checker.isArrayType(widened)) {
    const elemTs = checker.getTypeArguments(widened as ts.TypeReference)[0];
    if (!elemTs) return null;
    let elem = mapType(elemTs, ctx);
    // `undefined[]` (sparse literals — `[,]` — and explicit annotations):
    // the element rides the unit-only union like a record field would; the
    // VOID mapping is a return-position artifact, not a value.
    if (elem?.kind === "void" && isUnitOnlyTsType(elemTs, ctx.resolveTypeParam))
      elem = unitOnlyUnion(unions);

    if (!elem) return null;
    // `(T | undefined)[]` of a number, string or boolean T stores T
    // elements: an array slot holds a present undefined by its own state,
    // so a T[] seen as `(T | undefined)[]` stays the same array.
    let optionalElements = false;
    if (elem.kind === "union") {
      const arms = unions.get(elem.unionId)?.arms;
      const present =
        arms?.length === 2 ? arms.find((arm) => arm.kind !== "undefinedT") : undefined;
      if (
        present !== undefined &&
        arms!.some((arm) => arm.kind === "undefinedT") &&
        (present.kind === "f64" || present.kind === "string" || present.kind === "bool")
      ) {
        elem = present;
        optionalElements = true;
      }
    }
    // A dyn ELEMENT makes the WHOLE array the checked-dynamic value:
    // `unknown[]`, `object[]`, and the collapsed `(string | object)[]`
    // (the plugins-slot shape) — the checked-dynamic tree has real arrays, so length/
    // index/push/iteration ride the keyed-dyn paths. Native dyn-element
    // vectors are reserved for collection seeds and drains, rather than
    // changing this public representation. This is dynFallbackType's JS stance promoted into
    // the mapping itself; construction sites build dynArrLit (the checked-dynamic tree
    // array literal) and typed sources convert per element at the slot.
    // Arrays of class-backed protocol values are the exception: each
    // element is one checked-dynamic value (a class capsule or an object),
    // so a native array of them keeps every element's identity and passes
    // method calls a receiver they can dispatch.
    if (elem.kind === "dyn") return ctx.classImplementedProtocol?.(elemTs) ? arrayOf(DYN) : DYN;
    // The shared predicate is the runtime/backend storage contract. In
    // particular, valid standalone values such as Date and opaque
    // handles do not automatically have an array element representation.
    if (!isSupportedArrayElem(elem)) return null;
    // ChildProcess[] (the running-apps list) and Server[] (the [...set]
    // drain of the auxiliary-server registries): handles are ordinary
    // refcounted REF elements (their `_v` adapters, no trace — both drop
    // their closures at their terminal event).
    return optionalElements ? { kind: "array", elem, optionalElements: true } : arrayOf(elem);
  }
  // Tuples: `[string, string]` maps to an interned RECORD shape flagged
  // `tuple`, with one field per position named by its index ("0", "1", ...)
  // — fixed shape, literal-index access, length = the arity constant
  // (SEMANTICS.md). The flag keeps tuple shapes distinct from numeric-keyed
  // object records (JSON must serialize a tuple as an ARRAY) and is why
  // interning happens through the tuple-aware path. Optional/rest elements
  // have no fixed shape and stay unmapped; element types follow record-field
  // rules (no void/dyn).
  if (checker.isTupleType(widened)) {
    const ref = widened as ts.TupleTypeReference;
    // elementFlags live on the tuple SHAPE: a direct tuple type carries
    // them itself; a REFERENCE to one (isTupleType still answers true —
    // the facade's 5.9.3 contract) reads them off its target.
    const tupleShape =
      (ref.elementFlags as ts.ElementFlags[] | undefined) !== undefined
        ? ref
        : (ref.getTarget() as ts.TupleType | undefined);
    // The empty tuple `[]` — a declared annotation, or the facade edge
    // where isTupleType answers true with NO element flags on the shape or
    // its target (the empty-array arm of `''.match(/x/) || []`; the
    // declared `[]` reads the same way, 0 type arguments and no flags). A
    // zero-field tuple SHAPE would violate the IR's tuple invariant
    // (positional fields "0".."n-1", n >= 1), but the type needs no shape
    // at all — its only inhabitant is the empty array. It rides the ARRAY
    // representation over the unit-only element (the `undefined[]` rule):
    // length reads the runtime 0 and no element is ever written (push
    // takes `never`; indexed reads are out of range for tsc). Element-
    // FACING surfaces (JSON.stringify, spread, for-of) keep their
    // unit-element fences: no element exists, but the type-directed checks
    // see the unit arm.
    const args = checker.getTypeArguments(ref);
    if (args.length === 0) return arrayOf(unitOnlyUnion(unions));
    if (tupleShape?.elementFlags === undefined) return null;
    // A leading-required tuple ending in a rest element whose positions
    // all share one type (`[string, ...string[]]`, the non-empty list)
    // is an array of that type: every read, write and method behaves as
    // the array's, and tsc already proves the required positions exist.
    const flags = tupleShape.elementFlags;
    if (
      flags.length >= 2 &&
      (flags[flags.length - 1]! & ts.ElementFlags.Rest) !== 0 &&
      flags.slice(0, -1).every((f) => (f & ts.ElementFlags.Required) !== 0)
    ) {
      const elems = args.map((a) => mapType(a, ctx));
      const first = elems[0];
      if (
        first &&
        first.kind !== "void" &&
        isSupportedArrayElem(first) &&
        elems.every((e) => e !== null && typeEquals(e, first))
      )
        return arrayOf(first);
      return null;
    }
    // Optional/rest elements have no fixed native tuple layout.
    if (tupleShape.elementFlags.some((f) => !(f & ts.ElementFlags.Required))) {
      return null;
    }
    const fields: { name: string; type: IrType }[] = [];
    for (let i = 0; i < args.length; i++) {
      let et = (args[i]!.flags & ts.TypeFlags.Any) !== 0 ? DYN : mapType(args[i]!, ctx);
      // A unit-only element (`[number, undefined]`) rides the unit-only
      // union, the record-field rule.
      if (et?.kind === "void" && isUnitOnlyTsType(args[i]!, ctx.resolveTypeParam))
        et = unitOnlyUnion(unions);
      // dyn ELEMENTS map now — `[string, unknown]`, the Object.entries
      // tuple over an `unknown`-valued index signature (the pricing-table
      // normalizer shape): the slot has the overflow map's RC/JSON/dyn
      // plumbing, values arrive dyn or convert via dynFrom.
      if (!et || et.kind === "void") return null;

      // Object records may instead keep ambient abort handles in slots.

      fields.push({ name: String(i), type: et });
    }
    fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { kind: "record", shapeId: ctx.shapes.intern(fields, true) };
  }
  // BRANDED PRIMITIVES (`string & { readonly __brand: "UserId" }`,
  // `number & { readonly [tag]: "Meters" }`): the marker object is purely
  // type-level, so the value rides the primitive's runtime representation.
  // The recognizer is deliberately narrower than primitive-and-any-object:
  // runtime-bearing class, callable, indexed, and non-literal data shapes
  // remain intersections with no representation.
  if (widened.isIntersectionType()) {
    const errorMetadata = mapErrorMetadataIntersection(widened, ctx);
    if (errorMetadata) return errorMetadata;
    const brandedPrimitive = mapBrandedPrimitiveIntersection(widened, ctx);
    if (brandedPrimitive) return brandedPrimitive;
  }
  // REFINED handle intersections — @types/node's idioms: `ServerResponse<
  // IncomingMessage> & { req: IncomingMessage }` (RequestListener's
  // inferred res param — every unannotated http.createServer handler) and
  // the cast shape `Socket & { encrypted?: boolean }`. The VALUE is the
  // handle; the refinement's extra members are type-level decoration whose
  // uses fence per site (they are not stdlib members). Exactly one
  // constituent must map to an opaque builtin-handle kind; every other
  // part must be a plain object refinement — no call/construct signatures,
  // no class identity of its own.
  if (widened.isIntersectionType()) {
    let handle: IrType | null = null;
    let refined = true;
    for (const part of ts.constituentTypes(widened)) {
      const mapped = mapType(part, ctx);
      if (mapped && BUILTIN_HANDLE_KINDS.has(mapped.kind)) {
        if (handle !== null && handle.kind !== mapped.kind) {
          refined = false;
          break;
        }
        handle = mapped;
        continue;
      }
      const partSym = part.getSymbol();
      if (
        (part.flags & ts.TypeFlags.Object) === 0 ||
        checker.getCallSignatures(part).length > 0 ||
        checker.getConstructSignatures(part).length > 0 ||
        (partSym !== undefined && (partSym.flags & ts.SymbolFlags.Class) !== 0)
      ) {
        refined = false;
        break;
      }
    }
    if (refined && handle !== null) return handle;
    // MIXIN instance intersections (`Tagged.C & Derived` — values built
    // through a mixin result): the chain structure names the unique
    // pinned instantiation; ambiguity stays unmapped (the hook's rules).
    {
      const viaMixin = ctx.mixinIntersectionInstance?.(widened);
      if (viaMixin) {
        contextResolutions++;
        return viaMixin;
      }
    }
  }
  const classView = mapClassView(widened, ctx);
  if (classView !== undefined) {
    // An intersection of ONE compiled class instance with data-only object
    // types is a class instance carrying expando properties
    // (`Box & { preview?: Preview }`): the class owns the instance's
    // storage and the other members are properties the instance carries at
    // run time, so the class view has no single layout to answer (null).
    // The checked-dynamic representation IS that object model — one object,
    // the instance's identity and prototype, class fields reading and
    // writing through the live view, extra members in its property table.
    if (classView === null && widened.isIntersectionType()) {
      const expando = mapClassExpandoIntersection(widened, ctx);
      if (expando) return expando;
    }
    return classView;
  }
  // Class instances name a program class. The same symbol with construct
  // signatures names its static side, mapped to classval below.
  const widenedSym = widened.getSymbol();
  const classDecl = widenedSym ? widenedSym.valueDeclaration : undefined;
  if (
    classDecl &&
    (ts.isClassDeclaration(classDecl) || ts.isClassExpression(classDecl)) &&
    // Nameless class DECLARATIONS are legal only as `export default class
    // {}` — classNamer spells them "%anon" (unique per file), the same
    // name their collection registered.
    !ts.getSourceFileOfNode(classDecl).isDeclarationFile &&
    checker.getConstructSignatures(widened).length === 0 &&
    // A TypeScript class declared OUTSIDE the lowered program (reached
    // through `import type` alone) never registers, and the program can
    // hold no instance of it: its instance type maps below as the
    // structural type it describes, like an interface.
    (ctx.isProgramFile(ts.getSourceFileOfNode(classDecl)) ||
      isJsSourceFile(ts.getSourceFileOfNode(classDecl)))
  ) {
    // A JavaScript class outside the lowered program (jsdoc `typeof
    // import()` over a never-required module) stays unmappable: JSDoc
    // types are not checked, so its slots fall back to the dynamic value.
    if (!ctx.isProgramFile(ts.getSourceFileOfNode(classDecl))) return null;
    // The class inside a MIXIN function: per-call-site instantiations
    // share this one node — the CURRENT instantiation (collecting or
    // lowering) is the answer; outside any mixin context the node's type
    // stays unmapped (nothing names a call site).
    {
      const viaMixin = ctx.mixinClassInstance?.(classDecl);
      if (viaMixin) {
        contextResolutions++;
        return viaMixin;
      }
    }
    // A class declared `extends Array` (frontend/lowering/builtins/
    // array-classes.ts): its instances are arrays of the base's elements.
    {
      const arrayBase = arrayClassBaseType(classDecl, widened, ctx);
      if (arrayBase !== null) return arrayBase;
    }
    if (classExprNeedsContext(classDecl)) {
      const local = ctx.localClassInstance?.(classDecl, widened);
      if (local) contextResolutions++;
      return local ?? null;
    }
    // A GENERIC class's instance type (`Box<number>`) maps to the concrete
    // INSTANTIATION's class (`Box%0`), registered on demand — the Lowerer
    // hook owns the instance table (monomorphization by flow).
    if (classDecl.typeParameters?.nodes) {
      const instance =
        ctx.genericClassInstance?.(classDecl, widened, (argument) => mapType(argument, ctx)) ??
        null;
      // Before the generic declaration's collection turn, the hook can only
      // return its family shell; after collection the same checker type names
      // a concrete registered instance. Never memoize either phase's answer.
      if (instance !== null) contextResolutions++;
      return instance;
    }
    return { kind: "object", className: classNamer(classDecl) };
  }
  // A runtime-provided class's static side (`typeof EventEmitter`,
  // `typeof Readable`, `ErrorConstructor`): that class's value.
  {
    const runtimeClass = ctx.runtimeClassValue?.(widened);
    if (runtimeClass) return { kind: "classval", className: runtimeClass };
  }
  // The class STATIC side (`typeof C` — the class name as a value): the
  // same symbol WITH its construct signatures. Program classes only; lib
  // and package statics keep their fences.
  if (
    classDecl &&
    (ts.isClassDeclaration(classDecl) || ts.isClassExpression(classDecl)) &&
    !ts.getSourceFileOfNode(classDecl).isDeclarationFile &&
    checker.getConstructSignatures(widened).length > 0
  ) {
    if (!ctx.isProgramFile(ts.getSourceFileOfNode(classDecl))) return null;
    // The MIXIN class node's static side (`typeof C` inside the mixin):
    // the current instantiation's classval, like the instance type above.
    {
      const viaMixin = ctx.mixinClassInstance?.(classDecl);
      if (viaMixin?.kind === "object") {
        contextResolutions++;
        return { kind: "classval", className: viaMixin.className };
      }
    }
    if (classExprNeedsContext(classDecl)) {
      const ctorSigs = checker.getConstructSignatures(widened);
      const local = ctx.localClassInstance?.(
        classDecl,
        ctorSigs.length === 1 ? checker.getReturnTypeOfSignature(ctorSigs[0]!) : undefined,
      );
      if (local?.kind === "object") {
        contextResolutions++;
        return { kind: "classval", className: local.className };
      }
      return null;
    }
    // A GENERIC class's static side: only an INSTANTIATED one maps — an
    // instantiation expression's type (`Box<number>` as a value) carries a
    // construct signature returning the concrete instance, which maps to
    // the instantiation's classval. Uninstantiated `typeof Box` keeps the
    // type parameter in the construct signature's return — unmapped (the
    // family has no thunk and no single constructor ABI).
    if (classDecl.typeParameters?.nodes) {
      const ctorSigs = checker.getConstructSignatures(widened);
      if (ctorSigs.length !== 1) return null;
      const inst = mapType(checker.getReturnTypeOfSignature(ctorSigs[0]!), ctx);
      return inst?.kind === "object" ? { kind: "classval", className: inst.className } : null;
    }
    return { kind: "classval", className: classNamer(classDecl) };
  }
  // Constructor-signature TYPES (`new (…) => T`, an interface with one
  // construct signature): slots typed as constructables hold class
  // values whose instance type is T — classval of T's class. The spelled
  // signature is not part of the IR type: every value legally in the slot
  // shares the class's own completed constructor ABI (the upcast rule),
  // which is what newValue completes against. Only single-signature
  // constructables over PROGRAM class instances map; overload sets and
  // lib/package constructables stay unmapped (their fences name them).
  {
    const ctorSigs = checker.getConstructSignatures(widened);
    if (ctorSigs.length === 1 && checker.getCallSignatures(widened).length === 0) {
      const inst = mapType(checker.getReturnTypeOfSignature(ctorSigs[0]!), ctx);
      if (
        inst?.kind === "object" &&
        !RUNTIME_ERROR_CLASSES.has(inst.className) &&
        inst.className !== RUNTIME_EMITTER_CLASS &&
        !RUNTIME_STREAM_CLASSES.has(inst.className)
      ) {
        return { kind: "classval", className: inst.className };
      }
    }
    // A constructable declared in the program whose instances are not one
    // program class's (`new () => unknown`, `abstract new () => S` over a
    // record, a type that also names static members such as `{ readonly
    // schema: unknown; new (): unknown }`, construct overloads): the class
    // value rides the checked-dynamic tree, as an `unknown` slot already
    // holds one. `new` through it and static reads dispatch at run time,
    // and the constructed value checks into the signature's instance type.
    // Lib and package constructables keep their fences, and so do those of
    // fetched provenance sources (third-party code under its own policies:
    // an unused `@__PURE__` const typed `{ new (): any }` elides there).
    if (
      ctorSigs.length > 0 &&
      checker.getCallSignatures(widened).length === 0 &&
      (widened.getSymbol()?.declarations.length ?? 0) > 0 &&
      widened.getSymbol()!.declarations.every((d) => {
        const sf = ts.getSourceFileOfNode(d);
        return ctx.isProgramFile(sf) && !isProvenanceSourceFile(sf.fileName);
      })
    ) {
      return DYN;
    }
  }
  // Map<K, V>: a reference to the standard library's Map interface —
  // provenance, not the name (a user's own `interface Map` maps as a record
  // like any other). Keys are fenced to f64/string (SameValueZero hashing),
  // values to the supported kinds (see isSupportedMapValue); anything
  // outside stays unmapped — callers report the component fence (SC2009)
  // naming the offending half, as does the `new Map` lowering per site.
  const psym = widened.getSymbol();
  // The symbol's name and its standard-library declarations, asked once per
  // type (provenanceOf memoizes the answer per symbol). No symbol is named
  // "", so the absent symbol's placeholder names nothing.
  const psymName: string = psym === undefined ? "" : ts.symbolName(psym);
  const provenance = psym === undefined ? null : provenanceOf(psym, ctx);
  const isStdlibInterface = (name: string): boolean =>
    provenance !== null && name === psymName && provenance.stdlibInterface;
  // The async iteration protocols a `for await` source is annotated with
  // (and the older spelling of an async generator's iterator object). Node's
  // typings declare an interface named AsyncIterator too — the native handle
  // timers/promises.setInterval answers, which that builtin's lowering
  // builds — so only the ES lib's declarations take the protocol mapping.
  const isLibInterface = (name: string): boolean =>
    provenance !== null && name === psymName && provenance.libInterface;
  const isLibAsyncInterface = (name: string): boolean => isLibInterface(name);
  const isAsyncIterationProtocol = (): boolean =>
    isLibAsyncInterface("AsyncIterable") ||
    isLibAsyncInterface("AsyncIterator") ||
    isLibAsyncInterface("AsyncIterableIterator");
  // The timer handles: an interface in the fallback and in @types/node 22+,
  // a class (`class Timeout implements Timer`) in @types/node 20 and older.
  const isStdlibTimerHandle = (name: string): boolean =>
    provenance !== null && name === psymName && provenance.stdlibClass;
  return mapTypeInnerPart2(ctx, type, checker, unions, widened, flags, psym, psymName, provenance, isStdlibInterface, isLibInterface, isAsyncIterationProtocol, isStdlibTimerHandle);
}


/** A distributive conditional (`T extends "a" ? A : T extends "b" ? B :
 * never`, its check type a naked type parameter) over a parameter the
 * instance binds: evaluated once per member of the binding (`"a" | "b"`,
 * or the open `"a" | (string & {})` spelling), as the checker distributes
 * it. Answers the non-never results (empty when every member selects
 * never, so an optional member of that type holds only undefined, as in
 * the concrete instantiation), or null when the conditional is another
 * shape or a member does not evaluate. */
export function distributedConditionalParts(type: ts.Type, ctx: TypeMapperCtx): ts.Type[] | null {
  const { checker, resolveTypeParamTs } = ctx;
  if (!resolveTypeParamTs || !type.isConditionalType()) return null;
  const checkType = type.getCheckType();
  if (!checkType || !(checkType.flags & ts.TypeFlags.TypeParameter)) return null;
  const symbol = checkType.getSymbol();
  const bound = resolveTypeParamTs(checkType);
  if (!symbol || !bound) return null;
  // The answer depends on the instance's binding: a mapping that consults
  // it, even one that drops an all-never part, is not context-free.
  contextResolutions++;
  const parts: ts.Type[] = [];
  for (const member of bound.isUnionType() ? ts.constituentTypes(bound) : [bound]) {
    // `string & {}` (the open-union spelling) extends exactly what `string`
    // extends: the empty object adds nothing to a primitive.
    const emptyObject = (part: ts.Type): boolean =>
      (part.flags & ts.TypeFlags.Object) !== 0 &&
      checker.getPropertiesOfType(part).length === 0 &&
      checker.getIndexInfosOfType(part).length === 0 &&
      checker.getCallSignatures(part).length === 0 &&
      checker.getConstructSignatures(part).length === 0;
    const primitive = member.isIntersectionType()
      ? ts.constituentTypes(member).filter((part) => !emptyObject(part))
      : [member];
    if (primitive.length !== 1) return null;
    const evaluated = evalMappedTemplate(type, new Map(), new Map([[symbol, primitive[0]!]]), ctx);
    if (!evaluated) return null;
    if (checker.isNeverType(evaluated)) continue;
    if (!parts.includes(evaluated)) parts.push(evaluated);
  }
  return parts;
}


/** A union member that is a conditional only the member pattern decides
 * (memberPatternExtendsCheck) and that selects `never`: one distributed
 * member of `Extract<U, { k: T }>` whose `k` the literal this instance is
 * keyed on excludes. Such a member contributes no arm to the union. A
 * conditional the other rules already decide keeps their answer. */
export function memberPatternSelectsNever(part: ts.Type, ctx: TypeMapperCtx): boolean {
  if (!part.isConditionalType()) return false;
  const pinned = pinnedBindingsCtx(ctx);
  if (!pinned || evalMappedTemplate(part, new Map(), new Map(), ctx) !== null) return false;
  const selected = evalMappedTemplate(part, new Map(), new Map(), pinned);
  if (!selected || !ctx.checker.isNeverType(selected)) return false;
  // The answer depends on the instance's binding, like every mapping that
  // consults it.
  contextResolutions++;
  return true;
}


/** A conventional primitive brand has one runtime-carrying primitive part
 * and one or more phantom object parts whose fields are literal marker
 * values. The marker can use a string or unique-symbol key, can be imported
 * from a declaration file, can be expressed through a generic alias, and can
 * nest tables of further markers; none of those facts changes the runtime
 * value. Empty `{}` refinements are the marker-free form of the same
 * primitive narrowing.
 *
 * Arbitrary primitive/object intersections do not erase here. A companion
 * with a class identity, call/construct/index signature, accessor, or a
 * non-literal value field might describe runtime behavior, so it retains the
 * SC2008 refusal instead of borrowing the primitive representation. */
export function mapBrandedPrimitiveIntersection(widened: ts.Type, ctx: TypeMapperCtx): IrType | null {
  if (!widened.isIntersectionType()) return null;
  const { checker, resolveTypeParam, resolveTypeParamTs } = ctx;
  const primitivePart = (part: ts.Type): IrType | null => {
    const base = checker.getBaseTypeOfLiteralType(part);
    if (base.flags & ts.TypeFlags.Number) return F64;
    if (base.flags & ts.TypeFlags.String) return STRING;
    if (base.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) return BOOL;
    if (base.flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) return SYMBOL_T;
    if (base.flags & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) return BIGINT_T;
    if (base.flags & ts.TypeFlags.TypeParameter) {
      const bound = resolveTypeParam?.(base) ?? null;
      if (
        bound &&
        (bound.kind === "f64" ||
          bound.kind === "bigint" ||
          bound.kind === "string" ||
          bound.kind === "bool" ||
          bound.kind === "symbol")
      ) {
        contextResolutions++;
        return bound;
      }
    }
    return null;
  };
  const markerValue = (value: ts.Type, seen = new Set<ts.Type>()): boolean => {
    if (
      value.flags &
      (ts.TypeFlags.StringLiteral |
        ts.TypeFlags.NumberLiteral |
        ts.TypeFlags.BigIntLiteral |
        ts.TypeFlags.BooleanLiteral |
        ts.TypeFlags.UniqueESSymbol |
        ts.TypeFlags.EnumLiteral |
        ts.TypeFlags.Never |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Void |
        ts.TypeFlags.Null)
    ) {
      return true;
    }
    if (value.isUnionType())
      return ts.constituentTypes(value).every((part) => markerValue(part, seen));
    if (value.flags & ts.TypeFlags.TypeParameter) {
      const bound = resolveTypeParamTs?.(value) ?? null;
      if (bound) {
        contextResolutions++;
        return markerValue(bound, seen);
      }
    }
    // A NESTED marker table (`{ readonly ["~effect/Brand"]: { readonly
    // ProviderDriverKind: "ProviderDriverKind" } }`): an object whose own
    // members are all markers describes no runtime data, so the nesting
    // does not make the marker observable. Class identity, call, construct
    // or index signatures, accessors, and non-literal value fields stay
    // outside the rule, because those can describe runtime behavior.
    if ((value.flags & ts.TypeFlags.Object) === 0) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    // `seen` holds the types on the current path only: two sibling fields
    // that name the same marker type both erase, while a table that refers
    // to itself stays outside the rule.
    let marker = false;
    const sym = value.getSymbol();
    if (sym === undefined || (sym.flags & ts.SymbolFlags.Class) === 0) {
      marker =
        checker.getCallSignatures(value).length === 0 &&
        checker.getConstructSignatures(value).length === 0 &&
        checker.getIndexInfosOfType(value).length === 0 &&
        checker
          .getPropertiesOfType(value)
          .every(
            (prop) =>
              (prop.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) === 0 &&
              markerValue(checker.getTypeOfSymbol(prop), seen),
          );
    }
    seen.delete(value);
    return marker;
  };
  let primitive: IrType | null = null;
  let markerParts = 0;
  for (const part of ts.constituentTypes(widened)) {
    const mappedPrimitive = primitivePart(part);
    if (mappedPrimitive) {
      if (primitive && !typeEquals(primitive, mappedPrimitive)) return null;
      primitive = mappedPrimitive;
      continue;
    }
    const partSym = part.getSymbol();
    const props = checker.getPropertiesOfType(part);
    if (
      (part.flags & ts.TypeFlags.Object) === 0 ||
      checker.getCallSignatures(part).length > 0 ||
      checker.getConstructSignatures(part).length > 0 ||
      checker.getIndexInfosOfType(part).length > 0 ||
      (partSym !== undefined && (partSym.flags & ts.SymbolFlags.Class) !== 0) ||
      props.some(
        (prop) =>
          (prop.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) !== 0 ||
          !markerValue(checker.getTypeOfSymbol(prop)),
      )
    ) {
      return null;
    }
    markerParts++;
  }
  return primitive && markerParts > 0 ? primitive : null;
}
