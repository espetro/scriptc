// Statement slice of the former frontend/type-mapper.ts (split for
// maintainability; the directory barrel ../type-mapper.ts re-exports the
// original public surface). Statements are verbatim from the original file.
import { DYN, isUnitType, UNDEFINED_T, VOID } from "../../ir/ir.js";
import type { IrType } from "../../ir/ir.js";
import type { EnumObjectEntry } from "../enum-object-layout.js";
import * as ts from "../ts7/adapter.js";
import { ShapeRegistry } from "./s01.js";
import { UnionRegistry } from "./s02.js";
import type { ClassNamer, SymbolProvenance, TypeParamResolver, TypeParamTsResolver } from "./s04.js";
import { mapType } from "./s10.js";
import type { ErasedMentions } from "./s25.js";



/** Everything mapType needs besides the type itself: the checker, the two
 * interners (owned by the Lowerer), and the Lowerer-injected hooks. Built
 * once per Lowerer and threaded through the recursion — adding a hook means
 * one new field here, not a new parameter at every call site. */
export interface TypeMapperCtx {
  /** The own properties of this enum's object when the program builds it
   * (lowering/enum-objects.ts): then `typeof E` maps to the record of
   * them. Absent or null: the type stays unmapped, as for every enum only
   * read through its members. */
  enumObjectEntries?: (symbol: ts.Symbol) => readonly EnumObjectEntry[] | null;
  /** Whether the program creates primitive wrapper objects
   * (primitive-wrappers.ts): then the boxed interface types (`String`,
   * `Number`, `Boolean`) map to the checked-dynamic value instead of the
   * primitive. Absent or false: every mapping is unchanged. */
  primitiveWrappers?: () => boolean;
  /** Node islands (scope-B NI-4): whether a type's values are island
   * handles, which map to the `foreign` type (a dyn value). Absent in
   * programs without islands. */
  foreignType?: (type: ts.Type) => boolean;
  /** Set only while a union maps an arm that is the type inferred from an
   * empty object literal, beside another non-nullish arm: that arm holds
   * only the literal's objects, so it maps to the empty record (see the
   * empty object type rule in the object mapping). */
  emptyLiteralArm?: boolean;
  /** The array type of a property the checker types `never[]` or the
   * empty tuple: for an untyped empty array (`name: []`) its context's
   * type, or the one the typed slots its value reaches agree on; for an
   * alias of one (`list: o.files`) that array's type
   * (empty-array-places.ts). Null when nothing decides it. The Lowerer
   * supplies it. */
  untypedArrayPropertyType?: (
    decl: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  ) => IrType | null;
  /** The class value a generic factory's result type names when the factory
   * returns one of its own local classes through a constructor type
   * (`function struct<S>(v: S): Struct<S> { class Base {}; return Base as
   * Struct<S>; }`), by the checker type: the declared result inside the
   * instance being lowered, the instantiated result at its calls. */
  localClassValue?: (type: ts.Type) => IrType | null;
  checker: ts.TypeChecker;
  /** The structural position of a declaration (structural-positions.ts),
   * which names recursive placeholders independently of where unrelated
   * code sits. The Lowerer supplies it. */
  positionOf?: (node: ts.Node) => string;
  /** JavaScript declarations whose instance or object-literal types only
   * the checked-dynamic representation holds (js-dynamic-objects.ts).
   * Absent when the program has none: every mapping is unchanged. */
  jsDynamicDeclaration?: (decl: ts.Node) => boolean;
  /** Set while mapping a generic callable member's erased type
   * (erasedGenericMemberType): the signature's own type parameters
   * resolve to `unknown` instead of refusing the mapping. */
  erasingSignature?: ts.Signature;
  /** Set with erasingSignature: the signature's own type parameters, and
   * whether the erasure consulted an enclosing binding. An erasure that
   * resolved only its own parameters answers the same in every context. */
  erasedMember?: {
    own: ReadonlySet<ts.Type>;
    outerConsulted: boolean;
    /** The erasure's own resolver and what mentionsErasedTypeParam answered
     * under it (ErasedMentions). */
    resolve?: TypeParamResolver;
    mentions?: ErasedMentions;
  };
  /** True while an erased generic body lowers (its type parameters are
   * bound to `unknown`). */
  isErasing?: () => boolean;
  shapes: ShapeRegistry;
  unions: UnionRegistry;
  classNamer: ClassNamer;
  resolveTypeParam?: TypeParamResolver;
  /** The ts-level twin of resolveTypeParam (bound CHECKER types), consulted
   * only where literal identity matters — indexed accesses (`T[K]`) inside
   * generic bodies whose K is bound to a literal key. */
  resolveTypeParamTs?: TypeParamTsResolver;
  /** resolveTypeParamTs restricted to the parameters whose bound literals
   * the instance is keyed on (generic-functions.ts memberPatternTypeParams):
   * the instance serves no other binding of them, so its body may map a
   * type by them. Null for every other parameter. */
  resolvePinnedTypeParamTs?: TypeParamTsResolver;
  /** Set on the context pinnedBindingsCtx derives: evalMappedTemplate also
   * decides a conditional by its member pattern (memberPatternExtendsCheck). */
  memberPatterns?: true;
  /** The context pinnedBindingsCtx derived from this one, kept for reuse. */
  pinnedBindings?: TypeMapperCtx;
  /** A generic alias reference inside a generic body (`Catalog<G, P>`)
   * re-instantiated with the instance's bound type arguments: the concrete
   * checker type its signature instantiates, or null. Consulted only when
   * the symbolic form does not map. */
  resolveBoundAliasTs?: TypeParamTsResolver;
  /** How a standard-library primitive constructor held as a value is typed
   * (lowerToIr decides it per program). Off (the default): `typeof String`
   * is the constructor's own function type (primitiveConstructorType) and a
   * union of several constructors is one function arm. On: a primitive
   * constructor type, a union that holds one, and a list or a table of them
   * (an array, a tuple, an index signature) is the checked-dynamic value,
   * as `unknown` is; a declared member that holds one is an untyped member,
   * and a Map or a Set of them keeps its collection with untyped values
   * (`new Map` builds a typed collection). That is the tier that held a
   * table of constructors before the function form existed. The value in
   * it is the same function. */
  untypedConstructors?: boolean;
  /** Called each time a primitive constructor type maps to the
   * constructor's own function type (never under untypedConstructors). */
  onConstructorFunctionType?: () => void;
  /** The memo keys (mapType) of the types whose mapping reached
   * onConstructorFunctionType: an answer taken from the memo calls it again,
   * so a type that holds a constructor's function type reports it wherever
   * it is mapped, not only where it was mapped first. */
  constructorFunctionMemo?: Set<number>;
  /** Localized failure: the lenient mapping of a type whose strict mapping
   * failed at a committed slot (Lowerer.degradedTypes), or null. Consulted
   * only after the strict mapping (and its bound-alias retry) returns null,
   * at every depth, so every occurrence of a degraded type maps alike. */
  degradedType?: (type: ts.Type) => IrType | null;
  /** Localized failure's lenient mapping (Lowerer.lenientType): a nested
   * component whose mapping fails maps to the checked dynamic instead, so a
   * failing type keeps its outer shape with dynamic pieces. Only ever set
   * on a throwaway context without memoization. */
  lenient?: boolean;
  /** With `lenient`: told each component the lenient mapping turned into
   * the checked dynamic (Lowerer.lenientPieces). */
  onLenientPiece?: (type: ts.Type) => void;
  /** Canonical normalization's shadow mode (canon-map.ts): called after
   * each successful top-level mapping; installed only under
   * SCRIPTC_CANON_SHADOW=1. It records, and never changes a result. */
  canonShadow?: (type: ts.Type, mapped: IrType, ctx: TypeMapperCtx) => void;
  /** GENERIC program classes (monomorphization by flow): the mapping of a
   * concrete instantiation reference (`Box<number>`) — the Lowerer
   * registers/reuses the instantiation (`Box%0`) and answers its object
   * type; null when a type argument doesn't map, the cap tripped, or the
   * family never collected. The argument mapper retains substitutions from
   * class-derived interfaces as well as the current function bindings.
   * Absent in checkers with no lowering attached (generic instance types
   * stay unmapped there). */
  genericClassInstance?: (
    decl: ts.ClassLikeDeclaration,
    typeRef: ts.Type,
    mapArgument: (type: ts.Type) => IrType | null,
  ) => IrType | null;
  /** MIXIN class nodes (the class inside a mixin function): one shared
   * AST node, one instantiation per call site — the node's instance type
   * resolves to the instantiation CURRENTLY collecting/lowering (`this`
   * inside members, self-referential member types), null outside any
   * mixin context (the type alone cannot name a call site). */
  mixinClassInstance?: (decl: ts.ClassLikeDeclaration) => IrType | null;
  localClassInstance?: (decl: ts.ClassLikeDeclaration, instanceType?: ts.Type) => IrType | null;
  /** The runtime-provided class whose static side a type is (`typeof
   * EventEmitter`, `ErrorConstructor`), when values of it construct. */
  runtimeClassValue?: (type: ts.Type) => string | null;
  /** Live class protocols retain identity and receiver dispatch rather than
   * copying an instance into an unrelated record layout. */
  classImplementedProtocol?: (type: ts.Type) => boolean;
  /** MIXIN instance INTERSECTIONS (`Tagged.C & Derived` — values built
   * through a mixin result): resolved by chain structure to the unique
   * pinned instantiation they describe; null when ambiguous or when no
   * part names a mixin class node (lower-mixins.ts). */
  mixinIntersectionInstance?: (widened: ts.Type) => IrType | null;
  /** True for the STANDARD LIBRARY's files — the shipped ambient .d.ts or a
   * lib.*.d.ts bundled with typescript (program.isSourceFileDefaultLibrary).
   * Map/RegExp/Promise recognition needs declaration provenance: the name
   * alone proves nothing (a user's own `interface Map` maps as a record). */
  isStdlibFile: (sf: ts.SourceFile) => boolean;
  /** provenanceOf's answers, keyed by symbol (see SymbolProvenance). One
   * loaded program owns one map (lowering-facts.ts shares it across the
   * round's passes). Absent: provenanceOf creates one on the context
   * object. */
  symbolProvenance?: Map<ts.Symbol, SymbolProvenance>;
  /** SCRIPTC_LOWERING_FACTS_VERIFY: called on every hit on the symbol
   * provenance memo, so the caller can compare it with a fresh computation
   * (lowering-facts.ts throws on a disagreement). The optional webAssembly
   * and legacyUrl fields are filled lazily, on first use, by
   * declaresWebAssemblyNamespace/declaresLegacyUrl; the caller compares them
   * only when the stored answer has them. */
  verifySymbolProvenance?: (sym: ts.Symbol, answer: SymbolProvenance) => void;

  isNpmFile: (sf: ts.SourceFile) => boolean;
  /** True for a declaration file explicitly mapped by coverage's
   * --external-types option. These declarations are trusted as structural
   * type descriptions for project-owned values, but their imported runtime
   * bindings are fenced separately by the Lowerer. */
  isExternalTypeFile: (sf: ts.SourceFile) => boolean;
  /** The program's general stream representation (lowerToIr decides it
   * per program): NodeJS.ReadableStream / NodeJS.WritableStream and
   * @types/node's stream.Readable / stream.Writable map to the runtime
   * stream classes instead of the child/process stdio handles, so values
   * from every stream producer share their slots. Off (the default), the
   * stdio handles keep those spellings. */
  generalNodeStreams?: boolean;
  /** With generalNodeStreams, the program's checked-dynamic stream slots
   * (lowerToIr decides it per program, dyn-streams.ts): NodeJS.ReadableStream
   * and NodeJS.WritableStream map to the checked-dynamic representation, so
   * a slot holds a native stream (a boxed runtime stream, identity kept) or
   * a JavaScript stream object. Members dispatch per value at run time. */
  dynNodeStreams?: boolean;
  /** Whether the async-iteration protocol types over an element type hold
   * the checked-dynamic value (lowering/async-protocol-holders.ts):
   * AsyncIterable<T>, AsyncIterableIterator<T> and AsyncIterator<T> are a
   * compiled async generator unless the program moves another object into
   * one of them. The argument is the interface's type argument, with a
   * generic instance's type parameters bound. Absent, every protocol type is
   * a generator. */
  asyncProtocolHoldsImplementor?: (element: ts.Type | undefined) => boolean;
  /** Successful context-free mappings, keyed by the
   * TypeScript server's stable type id. A generated facade can reference the
   * same large record/function type thousands of times; remapping its full
   * member graph each time is quadratic work. Generic contexts memoize per
   * binding context instead (typeMemoFor), because the same checker type maps
   * differently under different instantiation bindings; mixin contexts still
   * opt out through canMemoizeType. */
  typeMemo?: Map<number, IrType>;
  /** The memo for the binding context active now (Lowerer.currentTypeMemo):
   * the top-level memo outside generic bindings, and one memo per installed
   * pair of binding maps inside them. Takes the place of typeMemo when set;
   * a hook rather than a field so that copies of the context made inside a
   * binding scope keep following the lowerer's current scope. */
  typeMemoFor?: () => Map<number, IrType>;
  /** Mappings that read no generic-instantiation scope state
   * (noteScopeSensitiveMapping): the answer is the one every binding scope
   * gives, so every scope and the top level may answer from it. Consulted
   * after the context's own memo, never instead of it — the top level's
   * typeMemo also holds answers that DID read an unbound type parameter and
   * are therefore only good outside bindings. */
  typeMemoShared?: Map<number, IrType>;
  canMemoizeType?: () => boolean;
  /** Whether the walk memo may hold this context's nested answers; absent,
   * canMemoizeType decides. A throwaway context that keeps its answers out
   * of the memos above (the lenient mapping) still maps each type it reaches
   * once. */
  canMemoizeWalk?: () => boolean;
  /** True for files the Lowerer actually compiles (its module order). A
   * class type can reach the entry through the TYPE world alone — a jsdoc
   * `typeof import('./mod')` over a module never imported at value level
   * pulls the file into the ts.Program without ever entering the lowered
   * program, so its classes never register and an object type naming one
   * would ICE the validator. Such instance types stay unmapped (null):
   * callers fence them like any other unsupported type. */
  isProgramFile: (sf: ts.SourceFile) => boolean;

  moduleNamespaceId?: (type: ts.Type) => string | null;
  /** The LifetimeRegion instance type (@scriptc/experimental), when `decl`
   * is that package's class declaration (lowering/lifetime-regions.ts). */
  lifetimeRegionClass?: (decl: ts.ClassDeclaration) => IrType | null;
  /** The InternTable instance type (@scriptc/experimental), when `decl` is
   * that package's class declaration (lowering/intern-tables.ts). */
  internTableClass?: (decl: ts.ClassDeclaration) => IrType | null;
  /** The ThreadSlots instance type (@scriptc/experimental), when `decl` is
   * that package's class declaration (lowering/thread-slots.ts). */
  threadSlotsClass?: (decl: ts.ClassDeclaration) => IrType | null;
}

/** A generator type's normalized value channels (Generator<T, TReturn,
 * TNext> and the IteratorResult alias share this):
 * - yield: `never` (a generator that never yields) rides the VOID
 *   sentinel; any/unknown ride dyn; undefined-only yields have no C value
 *   form (null); else the mapped type.
 * - return: void/undefined/never carry no value (VOID — the done-value is
 *   the undefined arm); any/unknown carry checked values. A defaulted or
 *   inferred return channel can still return a value and must preserve it.
 * - next: void/undefined/never mean valueless resumes (the undefined
 *   unit); any/unknown ride dyn; else the mapped type (`.next(v)` then
 *   requires its argument — fenced at the call site).
 * Mixed dyn/concrete value channels both use checked values because the
 * shared result record's value slot has one representation. */
export function genChannels(
  yieldTs: ts.Type | undefined,
  retTs: ts.Type | undefined,
  nextTs: ts.Type | undefined,
  ctx: TypeMapperCtx,
): { yieldT: IrType; retT: IrType; nextT: IrType } | null {
  if (!yieldTs) return null;
  const UNITISH = ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never;
  const ANYISH = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
  let yieldT: IrType | null;
  if (yieldTs.flags & ts.TypeFlags.Never) yieldT = VOID;
  else if (yieldTs.flags & ANYISH) yieldT = DYN;
  else {
    yieldT = mapType(yieldTs, ctx);
    if (yieldT?.kind === "void" || (yieldT && isUnitType(yieldT))) yieldT = null;
  }
  if (!yieldT) return null;
  const retT =
    retTs === undefined || retTs.flags & UNITISH
      ? VOID
      : retTs.flags & ANYISH
        ? DYN
        : mapType(retTs, ctx);
  if (!retT || (retT.kind !== "void" && isUnitType(retT))) return null;
  const nextT =
    nextTs === undefined || nextTs.flags & UNITISH
      ? UNDEFINED_T
      : nextTs.flags & ANYISH
        ? DYN
        : mapType(nextTs, ctx);
  if (!nextT || nextT.kind === "void" || nextT.kind === "nullT") return null;
  const ownChannel = (t: IrType): boolean =>
    t.kind === "f64" || t.kind === "bool" || t.kind === "string";
  // A record yield channel keeps its type beside a dyn return (an
  // `IterableIterator<Row>`). A record return channel beside a dyn yield
  // does not: the value a delegating `yield*` answers (Effect.gen's
  // generators) is often an object whose methods a record would drop.
  const dynMix =
    (yieldT.kind === "dyn" && retT.kind !== "dyn" && retT.kind !== "void" && !ownChannel(retT)) ||
    (retT.kind === "dyn" &&
      yieldT.kind !== "dyn" &&
      yieldT.kind !== "void" &&
      !ownChannel(yieldT) &&
      yieldT.kind !== "record");
  if (dynMix) return { yieldT: DYN, retT: DYN, nextT };
  return { yieldT, retT, nextT };
}


/** SELF-REFERENTIAL types recurse through mapType with no structural floor:
 * `function somefn() { return somefn; }` maps the return type by mapping the
 * function's own type again (the 15-stack-overflow-self-return signature),
 * and `new.target` in a class-field function expression builds the same
 * loop through the containing class. Legitimate types bottom out fast —
 * anything this deep is cyclic (or pathological), and unmappable (null) is
 * the honest answer: every call site already owns a fence or checked-dyn
 * fallback for it. */
export const MAP_TYPE_MAX_DEPTH = 64;
