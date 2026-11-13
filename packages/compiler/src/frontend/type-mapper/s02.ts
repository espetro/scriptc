// Statement slice of the former frontend/type-mapper.ts (split for
// maintainability; the directory barrel ../type-mapper.ts re-exports the
// original public surface). Statements are verbatim from the original file.
import { InternalCompilerError } from "../../errors.js";
import { typeEquals, typeKey } from "../../ir/ir.js";
import type { IrType, IrUnionDef, IrUnionDiscriminant } from "../../ir/ir.js";
import { keyedHelperName } from "../lowering/stable-names.js";
import { contentDigest } from "../lowering/unit-journal.js";
import type { HeldContents, JournalTable } from "../lowering/unit-journal.js";
import * as ts from "../ts7/adapter.js";
import { remapUnionDiscriminant } from "../union-discriminants.js";
import { RECURSIVE_NAME_DEPTH, recursivePlaceholderName } from "./s01.js";
import type { TypeMapperCtx } from "./s05.js";
import { PROGRESS_UNION } from "./s07.js";
import { walkRecursiveChanged } from "./s08.js";



/** A checker type's description for names that must not depend on checker
 * type ids (a recursive placeholder, a generic class instance keyed by a
 * literal): its printed form, the structural position of its first
 * declaration, and the same for its type arguments (two instantiations
 * print the same when their type arguments are type parameters or classes
 * of the same name from different declarations). */
export function checkerTypeDescription(
  t: ts.Type,
  ctx: Pick<TypeMapperCtx, "checker" | "positionOf">,
  depth = 0,
): string {
  const symbol = t.getAliasSymbol() ?? t.getSymbol();
  const declaration = symbol?.declarations[0];
  const where = declaration
    ? (ctx.positionOf?.(declaration) ??
      `${ts.getSourceFileOfNode(declaration).fileName}:${declaration.pos}`)
    : "";
  let description = `${ctx.checker.typeToString(t)}@${where}`;
  if (depth < RECURSIVE_NAME_DEPTH) {
    const aliasArguments =
      t.getAliasSymbol() !== undefined ? (t.getAliasTypeArguments() ?? []) : [];
    const typeArguments =
      aliasArguments.length > 0
        ? aliasArguments
        : t.isTypeReference()
          ? ctx.checker.getTypeArguments(t)
          : [];
    if (typeArguments.length > 0)
      description += `<${typeArguments.map((arg) => checkerTypeDescription(arg, ctx, depth + 1)).join(",")}>`;
  }
  return description;
}


/** The frontend's union interner — mirrors ShapeRegistry. A union's
 * canonical identity includes its typeKey-sorted arms and literal
 * discriminator contract. An arm's index in that list IS its runtime tag.
 * Owned by the Lowerer; threaded through mapType like ShapeRegistry. */
export class UnionRegistry {
  /** Existing arm/discriminator contracts change when a placeholder closes. */
  revision = 0;
  /** Each union id with a second hash of its key (keyedHelperName). */
  readonly keyedNameKeys = new Map<string, number>();
  private readonly byKey = new Map<string, string>();
  private readonly byId = new Map<string, IrUnionDef>();
  private readonly armTags = new Map<string, Map<string, number[]>>();
  /** All interned unions in first-seen order. */
  readonly unions: IrUnionDef[] = [];

  /** The sizes of the tables recursive unions change, which no unit
   * record carries (unit-journal.ts). */
  journalSizes(): number[] {
    return [this.revision, this.recIds.size, this.pendingRec.size];
  }

  /** The interned unions as a table unit records carry (unit-journal.ts).
   * An entry is a union's definition; applying it interns the union under
   * the key its arms give. A unit that adds a recursive union changes
   * journalSizes, so the unions past a unit's start are interned ones. */
  journalTable(): JournalTable {
    // The position of each union by id, for the unions indexed so far.
    let indexes = new Map<string, number>();
    let indexed = 0;
    const indexOf = (id: string): number | undefined => {
      if (indexed > this.unions.length) {
        indexes = new Map();
        indexed = 0;
      }
      for (; indexed < this.unions.length; indexed++)
        indexes.set(this.unions[indexed]!.id, indexed);
      const index = indexes.get(id);
      return index !== undefined && this.unions[index]?.id === id ? index : undefined;
    };
    return {
      name: "unions",
      size: () => this.unions.length,
      digest: (key, before) => {
        if (!this.byId.has(key)) return null;
        let index = indexOf(key);
        if (index === undefined) {
          // A list that was cut and grown again holds other unions at the
          // positions indexed before.
          indexes = new Map();
          indexed = 0;
          index = indexOf(key);
        }
        if (index === undefined || index >= before) return null;
        return contentDigest(JSON.stringify(this.unions[index]!));
      },
      holds: (entry) => {
        const def = JSON.parse(entry) as IrUnionDef;
        return this.byKey.has(unionKey(def.arms, def.discriminant));
      },
      entries: (from) => {
        const out: string[] = [];
        for (const def of this.unions.slice(from)) {
          // JSON writes a number that is not finite as null.
          const text = JSON.stringify(def);
          if (/[:,[]null\b/.test(text)) return null;
          out.push(text);
        }
        return out;
      },
      agrees: (entries) =>
        entries.every((entry) => {
          const def = JSON.parse(entry) as IrUnionDef;
          const held = this.byKey.get(unionKey(def.arms, def.discriminant));
          return held === undefined ? !this.byId.has(def.id) : held === def.id;
        }),
      apply: (entries) => {
        for (const entry of entries) {
          const def = JSON.parse(entry) as IrUnionDef;
          const key = unionKey(def.arms, def.discriminant);
          if (this.byKey.has(key)) continue;
          if (keyedHelperName(this, "u", key, "") !== def.id)
            throw new InternalCompilerError(`union record ${def.id} does not match its arms`);
          this.byKey.set(key, def.id);
          this.byId.set(def.id, def);
          this.unions.push(def);
        }
      },
      truncate: (from) => {
        while (this.unions.length > from) {
          const def = this.unions.pop()!;
          this.byKey.delete(unionKey(def.arms, def.discriminant));
          this.byId.delete(def.id);
          this.keyedNameKeys.delete(def.id);
        }
      },
      contents: () => {
        // A recursive placeholder still pending fills in place when its
        // outer frame completes, which changes journalSizes.
        const texts: (string | null)[] = [];
        const indexes = new Map<string, number>();
        const differs = (index: number): boolean => {
          const text = texts[index] ?? null;
          return (
            text !== null &&
            index < this.unions.length &&
            JSON.stringify(this.unions[index]!) !== text
          );
        };
        const held: HeldContents = {
          extend: () => {
            for (let index = texts.length; index < this.unions.length; index++) {
              const def = this.unions[index]!;
              texts.push(this.pendingRec.has(def.id) ? null : JSON.stringify(def));
              indexes.set(def.id, index);
            }
          },
          changed: () => {
            for (let index = 0; index < texts.length; index++)
              if (differs(index)) return this.unions[index]!.id;
            return null;
          },
          changedAmong: (keys) => {
            for (const key of keys) {
              const index = indexes.get(key);
              if (index !== undefined && differs(index)) return key;
            }
            return null;
          },
          refresh: (keys) => {
            for (const key of keys) {
              const index = indexes.get(key);
              if (
                index !== undefined &&
                index < this.unions.length &&
                (texts[index] ?? null) !== null
              )
                texts[index] = JSON.stringify(this.unions[index]!);
            }
          },
        };
        held.extend();
        return held;
      },
    };
  }
  /** ts.Types currently being mapped — a back-reference to one is the
   * recursive knot passing through a union (`type Tree = Leaf | Branch`
   * whose Branch arm carries `Tree[]`, the optional field `a?: A` of a
   * mutually recursive pair): mapType answers a NAMED RECURSIVE UNION
   * (recursiveRef) whose arms fill in when the outer frame completes. */
  readonly inProgress = new Set<ts.Type>();
  /** Recursive union ids, keyed by checker type identity — the
   * ShapeRegistry.recIds story exactly (per-declaration identity, byKey
   * folding one-level unfoldings in). */
  private readonly recIds = new Map<ts.Type, string>();
  private readonly pendingRec = new Set<string>();

  /** The union id a back-reference to an in-progress union resolves to:
   * reuses the type's persistent recursive id or mints a PLACEHOLDER
   * entry (empty arms) the outer frame finalizes. `describe` names a new
   * placeholder (checkerTypeDescription). */
  recursiveRef(t: ts.Type, describe: () => string): string {
    let id = this.recIds.get(t);
    if (id === undefined) {
      id = recursivePlaceholderName(this, "u", describe(), (name) => this.byId.has(name));
      walkRecursiveChanged(PROGRESS_UNION, t);
      const def: IrUnionDef = { id, arms: [] };
      this.byId.set(id, def);
      this.unions.push(def);
      this.recIds.set(t, id);
      this.pendingRec.add(id);
    }
    return id;
  }

  /** The FINALIZED recursive union for a checker type — undefined while
   * never mapped, mid-construction, or permanently failed. */
  recursiveUnionFor(t: ts.Type): string | undefined {
    const id = this.recIds.get(t);
    return id !== undefined && !this.pendingRec.has(id) ? id : undefined;
  }

  /** True when a back-reference minted a placeholder for `t` that the
   * outer frame has not (yet) finalized. */
  recursivePending(t: ts.Type): boolean {
    const id = this.recIds.get(t);
    return id !== undefined && this.pendingRec.has(id);
  }

  /** True when `unionId` is a recursive placeholder whose arms are not
   * known yet (its outer frame is still mapping, or failed). */
  isPendingPlaceholder(unionId: string): boolean {
    return this.pendingRec.has(unionId);
  }

  /** Completes a recursive placeholder with its canonical arm list and
   * registers the structural key (first writer wins, like shapes). */
  finalizeRecursive(t: ts.Type, arms: IrType[], discriminant?: IrUnionDiscriminant): string {
    const id = this.recIds.get(t);
    if (id === undefined)
      throw new InternalCompilerError(
        "union registry bug: finalizeRecursive without a placeholder",
      );
    if (this.pendingRec.has(id)) {
      walkRecursiveChanged(PROGRESS_UNION, t);
      const def = this.byId.get(id)!;
      def.arms.push(...arms);
      if (discriminant) def.discriminant = discriminant;
      this.pendingRec.delete(id);
      this.armTags.delete(id);
      this.revision++;
      const key = JSON.stringify([arms.map(typeKey), discriminant]);
      if (!this.byKey.has(key)) this.byKey.set(key, id);
    }
    return id;
  }

  /** Interns canonical arms and discriminator cases, returning their unionId. */
  intern(arms: IrType[], discriminant?: IrUnionDiscriminant): string {
    const key = unionKey(arms, discriminant);
    let id = this.byKey.get(key);
    if (id === undefined) {
      id = keyedHelperName(this, "u", key, "");
      const def: IrUnionDef = { id, arms, ...(discriminant ? { discriminant } : {}) };
      this.byKey.set(key, id);
      this.byId.set(id, def);
      this.unions.push(def);
    }
    return id;
  }

  /** An exact arm transformation keeps the source's semantic variants. */
  transform(source: IrUnionDef, arms: IrType[]): string {
    return this.intern(arms, remapUnionDiscriminant(source, arms));
  }

  get(unionId: string): IrUnionDef | undefined {
    return this.byId.get(unionId);
  }

  /** Index large arm lists once. Exact equality still resolves type-key
   * collisions, including optional function ABI flags. */
  armTag(unionId: string, arm: IrType): number {
    const def = this.byId.get(unionId);
    if (!def) return -1;
    if (def.arms.length < 8) return def.arms.findIndex((candidate) => typeEquals(candidate, arm));
    let tags = this.armTags.get(unionId);
    if (!tags) {
      tags = new Map<string, number[]>();
      def.arms.forEach((candidate, tag) => {
        const key = typeKey(candidate);
        const previous = tags!.get(key);
        if (previous) previous.push(tag);
        else tags!.set(key, [tag]);
      });
      this.armTags.set(unionId, tags);
    }
    return tags.get(typeKey(arm))?.find((tag) => typeEquals(def.arms[tag]!, arm)) ?? -1;
  }
}


/** The key UnionRegistry interns a union's arms and discriminant under. */
export function unionKey(arms: readonly IrType[], discriminant: IrUnionDiscriminant | undefined): string {
  return JSON.stringify([arms.map(typeKey), discriminant]);
}
