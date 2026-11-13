// Statement slice of the former frontend/type-mapper.ts (split for
// maintainability; the directory barrel ../type-mapper.ts re-exports the
// original public surface). Statements are verbatim from the original file.
import { InternalCompilerError } from "../../errors.js";
import { F64, KEY_ORDER_FIELD, typeKey } from "../../ir/ir.js";
import type { IrRecordField, IrRecordShape, IrType } from "../../ir/ir.js";
import { keyedHelperName } from "../lowering/stable-names.js";
import type { KeyedNameOwner } from "../lowering/stable-names.js";
import * as ts from "../ts7/adapter.js";
import { comparePriority } from "./s00.js";
import type { DeclaredOrderPriority } from "./s00.js";
import { PROGRESS_RECORD } from "./s07.js";
import { walkRecursiveChanged } from "./s08.js";



/** The frontend's record-shape interner. Records are monomorphic structural
 * shapes: fields sorted by name form the canonical identity, and two types
 * with the same canonical field list share one shapeId (and later one C
 * struct). Owned by the Lowerer; `mapType` needs it to intern the object
 * types it encounters, which is why it is threaded through as a parameter. */
export class ShapeRegistry {
  /** Existing layouts change only when a recursive placeholder closes. */
  revision = 0;
  /** Each shape id with a second hash of its key (keyedHelperName). */
  readonly keyedNameKeys = new Map<string, number>();
  private readonly byKey = new Map<string, string>();
  private readonly byId = new Map<string, IrRecordShape>();
  /** Historical emit-order rank of the declaration-order metadata each
   * shape kept. Collection runs at rank 0; retained reachability bodies
   * install their old emit positions while they lower. This lets a body
   * reached after an init replace metadata the worklist encountered first
   * when the old emitter would have lowered that body first. */
  private readonly declaredOrderPriority = new Map<string, DeclaredOrderPriority>();
  private readonly declaredOrderCandidates = new Map<
    string,
    { order: string[]; priority: DeclaredOrderPriority }[]
  >();
  /** Derived shapes whose order is inherited from another shape. The
   * source can settle after the derived shape was interned (notably
   * Partial<T> inside a retained generic body), so refresh the adopted
   * writer after all priority candidates have closed. */
  private readonly derivedDeclaredOrderFinalizers: (() => void)[] = [];
  private currentDeclaredOrderPriority: DeclaredOrderPriority = [0, 0];
  /** The rank a shape interned now offers its key order under: a mapping
   * repeated under another rank offers the order again (the walk memo). */
  declaredOrderRank(): DeclaredOrderPriority {
    return this.currentDeclaredOrderPriority;
  }
  /** The declared-order candidates and the attached names the registry
   * holds, counted as they are added (journalSizes). */
  private candidateCount = 0;
  private extendedCount = 0;
  /** All interned shapes in first-seen order. */
  readonly shapes: IrRecordShape[] = [];

  /** The sizes of the registry's tables, which only grow while shapes are
   * interned (unit-journal.ts). */
  journalSizes(): number[] {
    return [
      this.revision,
      this.shapes.length,
      this.byKey.size,
      this.byId.size,
      this.keyedNameKeys.size,
      this.declaredOrderPriority.size,
      this.declaredOrderCandidates.size,
      this.candidateCount,
      this.derivedDeclaredOrderFinalizers.length,
      this.recIds.size,
      this.pendingRec.size,
      this.extendedNames.size,
      this.extendedCount,
    ];
  }
  /** ts.Types currently being mapped — a BACK-REFERENCE to one of these is
   * the recursive knot (`interface TreeNode { children: TreeNode[] }`):
   * mapType answers a NAMED RECURSIVE SHAPE (recursiveRef) whose fields
   * fill in when the outer frame completes. */
  readonly inProgress = new Set<ts.Type>();
  /** RECURSIVE shape ids, keyed by CHECKER TYPE identity: one shapeId per
   * declaration site (the checker canonicalizes interface/alias types per
   * declaration, and caches generic instantiations, so the same spelling
   * is the same ts.Type). Cross-declaration structural unification exists
   * only through the byKey registration finalizeRecursive performs — a
   * one-level unfolding that references the same knot (`{ next: T }` where
   * `type T = { next: T }`) folds into the knot's id; two INDEPENDENT
   * structurally identical recursive declarations intern as distinct
   * shapes, so values of one fence at the other's slots with the ordinary
   * shape-mismatch diagnostic (tsc admits the assignment; the exact-shape
   * stance reports it — the documented v1 width/assignability consequence
   * of per-declaration identity). */
  private readonly recIds = new Map<ts.Type, string>();
  /** Placeholder ids minted but not yet finalized: mid-construction, or
   * permanently pending when the outer mapping failed (such shapes are
   * referenced by nothing reachable and prune at module assembly). */
  private readonly pendingRec = new Set<string>();

  /** The interning key of a canonical field list — shared by intern and
   * finalizeRecursive so the two registration paths can never disagree. */
  private keyOf(fields: readonly IrRecordField[], tuple: boolean, indexValue?: IrType): string {
    return (
      (tuple ? "tuple!" : "") +
      (indexValue ? `idx<${typeKey(indexValue)}>!` : "") +
      // An absentable optional dyn field carries a third element in the
      // key; every other entry keeps the historical two-element spelling,
      // so a shape without one hashes exactly as before (zero-cost
      // identity for programs that use no optional `unknown`/`any`).
      JSON.stringify(
        fields.map((f) =>
          f.optional === true ? [f.name, typeKey(f.type), 1] : [f.name, typeKey(f.type)],
        ),
      )
    );
  }

  /** Runs one lowering unit under its historical emit-order rank. Shape
   * ids remain demand-assigned; only first-seen declaration-order metadata
   * uses this rank, because Object.keys/JSON/inspect observe it. */
  withDeclaredOrderPriority<T>(priority: DeclaredOrderPriority, fn: () => T): T {
    const previous = this.currentDeclaredOrderPriority;
    this.currentDeclaredOrderPriority = priority;
    try {
      return fn();
    } finally {
      this.currentDeclaredOrderPriority = previous;
    }
  }

  private adoptDeclaredOrder(shape: IrRecordShape, declaredOrder: string[] | undefined): void {
    if (declaredOrder === undefined) return;
    this.candidateCount++;
    const candidates = this.declaredOrderCandidates.get(shape.id);
    const candidate = { order: declaredOrder, priority: this.currentDeclaredOrderPriority };
    if (candidates) candidates.push(candidate);
    else this.declaredOrderCandidates.set(shape.id, [candidate]);
    const previous = this.declaredOrderPriority.get(shape.id);
    if (
      previous !== undefined &&
      comparePriority(previous, this.currentDeclaredOrderPriority) <= 0
    ) {
      return;
    }
    shape.declaredOrder = this.withExtendedNames(shape.id, declaredOrder);
    this.declaredOrderPriority.set(shape.id, this.currentDeclaredOrderPriority);
  }

  /** Mutable generic-instance ranks settle only after reachability closes.
   * Re-choose each shape's first historical writer from the retained
   * candidates before derived metadata and helper bodies finalize. */
  settleDeclaredOrderPriorities(): void {
    for (const [shapeId, candidates] of this.declaredOrderCandidates) {
      let best = candidates[0];
      if (!best) continue;
      for (const candidate of candidates.slice(1)) {
        if (comparePriority(candidate.priority, best.priority) < 0) best = candidate;
      }
      const shape = this.byId.get(shapeId);
      if (!shape) continue;
      shape.declaredOrder = this.withExtendedNames(shapeId, best.order);
      this.declaredOrderPriority.set(shapeId, best.priority);
    }
    for (const finalize of this.derivedDeclaredOrderFinalizers) finalize();
  }

  /** Tracks a derived shape that inherits its key order unchanged from a
   * source shape. Identity-gating preserves first-writer-wins when an
   * equivalent derived shape was already adopted from another source. */
  inheritDeclaredOrder(shapeId: string, originalOrder: string[], sourceShapeId: string): void {
    this.derivedDeclaredOrderFinalizers.push(
      this.declaredOrderFinalizer(
        shapeId,
        originalOrder,
        () => this.get(sourceShapeId)?.declaredOrder,
      ),
    );
  }

  /** Captures the current historical rank for a derived shape whose order
   * must be recomputed after retained reachability settles its source. */
  declaredOrderFinalizer(
    shapeId: string,
    originalOrder: string[],
    order: () => string[] | undefined,
  ): () => void {
    return () => {
      const shape = this.byId.get(shapeId);
      // Only the writer whose array the shape actually adopted may revise
      // it. Another structurally-equal type at the same historical rank
      // still obeys first-writer-wins.
      if (shape?.declaredOrder !== originalOrder) return;
      const next = order();
      if (next !== undefined) shape.declaredOrder = this.withExtendedNames(shape.id, next);
    };
  }

  /** The shape id a back-reference to an in-progress type resolves to:
   * reuses the type's persistent recursive id or mints a PLACEHOLDER
   * entry (empty fields) the outer frame finalizes. `describe` names a new
   * placeholder (checkerTypeDescription). */
  recursiveRef(t: ts.Type, describe: () => string): string {
    let id = this.recIds.get(t);
    if (id === undefined) {
      id = recursivePlaceholderName(this, "r", describe(), (name) => this.byId.has(name));
      walkRecursiveChanged(PROGRESS_RECORD, t);
      const shape: IrRecordShape = { id, fields: [] };
      this.byId.set(id, shape);
      this.shapes.push(shape);
      this.recIds.set(t, id);
      this.pendingRec.add(id);
    }
    return id;
  }

  /** The FINALIZED recursive shape for a checker type — undefined while
   * never mapped, mid-construction, or permanently failed. */
  recursiveShapeFor(t: ts.Type): string | undefined {
    const id = this.recIds.get(t);
    return id !== undefined && !this.pendingRec.has(id) ? id : undefined;
  }

  /** True when a back-reference minted a placeholder for `t` that the
   * outer frame has not (yet) finalized. */
  recursivePending(t: ts.Type): boolean {
    const id = this.recIds.get(t);
    return id !== undefined && this.pendingRec.has(id);
  }

  /** Completes a recursive placeholder with its computed field list and
   * registers the structural key (first writer wins — the key may already
   * belong to a structurally identical shape; the recursive id stays
   * authoritative for its own checker type either way). */
  finalizeRecursive(
    t: ts.Type,
    fields: IrRecordField[],
    indexValue?: IrType,
    declaredOrder?: string[],
  ): string {
    const id = this.recIds.get(t);
    if (id === undefined)
      throw new InternalCompilerError(
        "shape registry bug: finalizeRecursive without a placeholder",
      );
    if (this.pendingRec.has(id)) {
      walkRecursiveChanged(PROGRESS_RECORD, t);
      const shape = this.byId.get(id)!;
      shape.fields = fields;
      if (indexValue) shape.indexValue = indexValue;
      this.adoptDeclaredOrder(shape, declaredOrder);
      this.pendingRec.delete(id);
      this.revision++;
      const key = this.keyOf(fields, false, indexValue);
      if (!this.byKey.has(key)) this.byKey.set(key, id);
    }
    return id;
  }

  /** Interns a canonical (name-sorted) field list, returning its shapeId.
   * `tuple` shapes (fields "0".."n-1" from a tuple type) intern SEPARATELY
   * from structurally identical numeric-keyed object records: the flag is
   * part of the identity because the two serialize differently (a tuple is
   * a JSON array, an object a JSON object). A string index signature's
   * value type (`indexValue`) is part of the identity too: the same
   * declared fields with and without an overflow portion — or with
   * differently-typed ones — are different structs. */
  intern(
    fields: IrRecordField[],
    tuple = false,
    indexValue?: IrType,
    declaredOrder?: string[],
  ): string {
    const key = this.keyOf(fields, tuple, indexValue);
    let id = this.byKey.get(key);
    if (id === undefined) {
      id = keyedHelperName(this, "r", key, "");
      const shape: IrRecordShape = {
        id,
        fields,
        ...(tuple ? { tuple: true as const } : {}),
        ...(indexValue ? { indexValue } : {}),
        // First-seen declaration order — metadata, NOT identity (see the
        // IrRecordShape doc): a later structurally-equal type keeps the
        // first one's order.
        ...(declaredOrder ? { declaredOrder } : {}),
      };
      this.byKey.set(key, id);
      this.byId.set(id, shape);
      this.shapes.push(shape);
      if (declaredOrder !== undefined) {
        this.candidateCount++;
        this.declaredOrderCandidates.set(id, [
          { order: declaredOrder, priority: this.currentDeclaredOrderPriority },
        ]);
        this.declaredOrderPriority.set(id, this.currentDeclaredOrderPriority);
      }
    } else {
      this.adoptDeclaredOrder(this.byId.get(id)!, declaredOrder);
    }
    return id;
  }

  get(shapeId: string): IrRecordShape | undefined {
    return this.byId.get(shapeId);
  }

  /** Names extendShape added to a shape, which every key-order table the
   * shape adopts lists after its declared names. */
  private readonly extendedNames = new Map<string, string[]>();

  /** The members extendShape attached to a shape (empty for most). */
  attachedNames(shapeId: string): readonly string[] {
    return this.extendedNames.get(shapeId) ?? [];
  }

  private withExtendedNames(shapeId: string, order: string[]): string[] {
    const extra = this.extendedNames.get(shapeId);
    if (!extra) return order;
    const missing = extra.filter((name) => !order.includes(name));
    return missing.length === 0 ? order : [...order, ...missing];
  }

  /** Gives a shape with orderVariants its KEY_ORDER_FIELD, in place,
   * after the bodies lowered (key-order-witness.ts adds the field to each
   * of the shape's literals). Allocation zeroes it, which every other
   * construction keeps. */
  addKeyOrderField(shapeId: string): void {
    const shape = this.byId.get(shapeId);
    if (!shape || shape.fields.some((f) => f.name === KEY_ORDER_FIELD)) return;
    shape.fields = [...shape.fields, { name: KEY_ORDER_FIELD, type: F64 }].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    this.revision++;
    const key = this.keyOf(shape.fields, false, shape.indexValue);
    if (!this.byKey.has(key)) this.byKey.set(key, shapeId);
  }

  /** Adds optional fields to an interned shape in place: members a type
   * assertion attaches to the shape's values (`r as R & { tag: string }`
   * followed by `view.tag = ...`; see assertion-members.ts). Every value
   * of the shape holds them absent until a write through such a view, so
   * the shape keeps its id, both structural keys resolve to it, and its
   * key-order table lists the new names after the declared ones. Runs
   * before any body lowers; existing layouts change, so the revision
   * advances like a closing recursive placeholder. */
  extendShape(shapeId: string, extra: readonly { name: string; type: IrType }[]): void {
    const shape = this.byId.get(shapeId);
    if (!shape || shape.tuple || extra.length === 0) return;
    const fresh = extra.filter((f) => !shape.fields.some((x) => x.name === f.name));
    if (fresh.length === 0) return;
    shape.fields = [...shape.fields, ...fresh].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    this.extendedCount += fresh.length;
    this.extendedNames.set(shapeId, [
      ...(this.extendedNames.get(shapeId) ?? []),
      ...fresh.map((f) => f.name),
    ]);
    if (shape.declaredOrder)
      shape.declaredOrder = this.withExtendedNames(shapeId, shape.declaredOrder);
    const candidates = this.declaredOrderCandidates.get(shapeId);
    if (candidates) {
      for (const c of candidates) c.order = this.withExtendedNames(shapeId, c.order);
    }
    this.revision++;
    const key = this.keyOf(shape.fields, false, shape.indexValue);
    if (!this.byKey.has(key)) this.byKey.set(key, shapeId);
  }
}


/** The id of a recursive placeholder described by `description`. Two
 * different types can still share a description (checkerTypeDescription stops
 * after a few levels of type arguments); the later one takes the first free
 * name with a numbered suffix. */
export function recursivePlaceholderName(
  owner: KeyedNameOwner,
  prefix: string,
  description: string,
  taken: (name: string) => boolean,
): string {
  let name = keyedHelperName(owner, prefix, `recursive:${description}`, "");
  for (let n = 1; taken(name); n++)
    name = keyedHelperName(owner, prefix, `recursive:${description}#${n}`, "");
  return name;
}


/** How many levels of type arguments checkerTypeDescription describes. */
export const RECURSIVE_NAME_DEPTH = 3;
