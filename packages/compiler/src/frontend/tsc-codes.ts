/** Compiler options adopted from the project during preflight. */
export const ADOPTED_OPTIONS = [
  "strict",
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "strictBuiltinIteratorReturn",
  "noImplicitThis",
  "alwaysStrict",
  "useUnknownInCatchVariables",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noPropertyAccessFromIndexSignature",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "noUnusedLocals",
  "noUnusedParameters",
  "allowUnusedLabels",
  "allowUnreachableCode",
  "skipLibCheck",
  // Import-form interop knobs: they only change which import FORMS
  // typecheck (default imports of CJS-shaped types) — the import fence
  // rejects unsupported forms with SC-diagnostics either way, and a
  // SC1012 "not supported yet" beats a raw TS1259 at the same site.
  "esModuleInterop",
  "allowSyntheticDefaultImports",
] as const;

export const JS_RELAXED_TSC_CODES: ReadonlySet<number> = new Set([
  // implicit any (params, variables, elements, this, returns, rest,
  // construct signatures, index reads over shapes with no index
  // signature — typeof globalThis)
  2683,
  7005,
  7006,
  7008,
  7009,
  7010,
  7015,
  7017,
  7019,
  7022,
  7023,
  7024,
  7031,
  7034,
  7053,
  // strict-null narrowing demands (possibly null/undefined receivers)
  2531,
  2532,
  2533,
  18047,
  18048,
  18049,
  // assignability/arity/callability of dynamic call shapes (valid JS,
  // checked at runtime by Node; the lowerer re-checks every lowered form
  // per site) and member/existence probes over dynamic shapes (expando
  // properties, capability probes — the lowerer fences unknown members
  // per site with the SC2020 family)
  2322,
  2339,
  2345,
  2349,
  2351,
  2367,
  2554,
  2555,
  2556,
  2769,
  2740, // 2322's elaborated "missing the following properties" form
  2559, // a value with no properties in common with an all-optional options type
  2305,
  2551,
  2724,
  2731,
  // excess object-literal properties against a JSDoc-inferred contextual
  // type (and the did-you-mean variant): ordinary, working JS — the extra
  // key rides the object at runtime exactly as written (the formatter idiom's
  // expand-patterns passes an ignoreUnknown member its own JSDoc type
  // never declared)
  2353,
  2561,
  // JSDoc TYPE-SPACE claims that fail to check: a value name in a type
  // position (2749/2702), generic constraints and index types spelled in
  // typedefs (2344/2536/2538), an async @returns that is not Promise
  // (1064), and 2366's no-ending-return against a JSDoc-declared return
  // type. The claims are documentation — Node never reads them; the
  // values keep their runtime behavior and every use meets the per-site
  // fences (the pattern's source carries dozens of each).
  2749,
  2702,
  2344,
  2536,
  2538,
  1064,
  2366,
  // strict-null demands on dynamic shapes, continued: iterating/invoking
  // possibly-undefined values (runtime re-checks at the site)
  2488,
  2721,
  2722,
  // an UNUSED @ts-expect-error: the directive annotated an error visible
  // under the project's OWN tsconfig world — scriptc's world deliberately
  // differs (adopted options, hidden declaration twins), and an unused
  // suppression changes nothing at runtime
  2578,
  // a lib-floor demand (es2024+ members under the es2023 lib): the member
  // types as the error-any and its use fences per site with the honest
  // no-lowering story instead of gating the whole program
  2550,
  // `export *` ambiguity (2308): Node DEFINES this case — ambiguous names
  // are excluded from the star surface — where tsc asks for an explicit
  // re-export; and 2305's did-you-mean sibling 2614 joins 2305
  2308,
  2614,
  // 2740's sibling elaboration ("Property X is missing in type Y")
  2741,
  // JavaScript subclasses may widen fields or add method parameters.
  // Class lowering checks native storage and override ABIs at each use.
  2415,
  // unresolvable modules: Node throws WHEN the require executes — the
  // binding types as any and reached uses fence instead of passing unchecked
  2307,
  2792,
  // useUnknownInCatchVariables' annotation demand ("'e' is of type
  // 'unknown'", "Object is of type 'unknown'"): a JS catch clause CANNOT
  // annotate its variable, so the demand is unsatisfiable in source —
  // exactly the implicit-any story above. The values stay 'unknown' and
  // every use meets the lowerer's per-site unknown fences (member reads
  // ride the checked-dynamic tree; unsupported operations report a compile-time diagnostic).
  18046,
  2571,
  // capability probes that read as always-true conditions to the checker
  // (`Object.create ? fn : fallback` in tslib/downlevel helpers): the
  // ternary still picks its branch at runtime; whatever the chosen branch
  // does meets the per-site fences
  2774,
  // noImplicitOverride's JSDoc demand on JS classes: comment semantics —
  // the same family as the 8xxx JSDoc range suppressedJsStrictness7 drops
  // wholesale; override correctness is checked by class lowering
  4119,
  // noImplicitReturns: falling off the end yields undefined, ordinary JS;
  // the read sites fence the value they actually see
  7030,
  // strictNullChecks-era demands: `delete` on a required property (2790)
  // is runtime-legal JS and the delete site gets its own lowering verdict;
  // strictPropertyInitialization's use-before-assign (2565) on JS class
  // fields is the implicit-any story — the field exists, the checker just
  // cannot prove the constructor's assignment path
  2790,
  2565,
  // structural-assignability noise on JS class shapes: 2739's "missing
  // properties" (a JS exception class vs the Error contract) joins 2740 /
  // 2741 already above, and 2629's "cannot assign to a class" fires on the
  // downleveled `Class || (exports.Class = Class = {})` merge idiom —
  // runtime-legal rebinding inside the class's own IIFE
  2739,
  2629,
  // environment capability probes an ES-lib world cannot name: unbound
  // globals in JS (`window`, `document`, `self`, `XMLHttpRequest`,
  // `WebAssembly`, `Temporal`, ...) are dynamic by nature — they read as
  // error-any and their uses meet the per-site fences, exactly like the
  // unresolved-module story of 2307/2792. 2584 is the same demand wearing
  // the "change your lib" wording (a lib-floor claim like 2550).
  2304,
  2584,
  // instanceof against a dynamic right-hand side — joins the callability
  // family 2349/2351/2367 above; whatever the RHS holds at runtime meets
  // the instanceof fence at the site
  2359,
  // JSDoc TYPE-SPACE claims, continued: namespace lookups and generic
  // arity inside @type/@param/@param-import tags (2503's missing
  // namespace, 2694's missing exported member, 2314's bare `Promise`) —
  // documentation claims Node never reads, same family as 2749/2702/2344
  2503,
  2694,
  2314,
  // hoisted-`var` redeclaration with a second inferred type (2403) and
  // property/base assignability (2416): dynamic-shape inference noise,
  // same story as 2322/2339/2415 — the values are real, the sites fence
  2403,
  2416,
  // void-position truthiness tests and the empty-if-body lint (1345,
  // 1313): valid JS whose runtime behavior is fully defined — falsy,
  // and no body — on vendored UMD/minified shapes
  1345,
  1313,
  // implicit-any via a set accessor without a parameter annotation
  // (7032): the same implicit-any family as 7005/7006/7017 above
  7032,
  // arity/inference noise: `new Promise()` needing a JSDoc hint to type
  // a zero-arg resolve call (2810), and 2630's assignment to a function
  // — the `Fn || (Fn = {})` merge idiom, sibling of 2629
  2810,
  2630,
  // definite-assignment demands the checker cannot prove (2454 local
  // used-before-assigned): the strict-null family story — the runtime
  // value is what it is, and the site fences
  2454,
  // a JSDoc-declared return type demands a return (2355): the same
  // declared-type-space story as 7030/2366; 2378 is its accessor sibling
  2355,
  2378,
  // expando writes through a namespace-import binding (`Utils.X = ...`,
  // `URI.x = ...`) read as "read-only property" violations (2540): the
  // same merge-idiom rebinding as 2629/2630 — runtime-legal JS where the
  // namespace object is mutable
  2540,
  // the minified-JS lint family: unused comma-operator left side (2695)
  // and arithmetic on a dynamic operand (2356 — the error-any shape of
  // 2362/2363/2365 with the operand spelled by inference instead)
  2695,
  2356,
  // a generator `yield` with no declared return type (7057): the
  // implicit-any family above
  7057,
]);

/* Arithmetic on an `any` operand (TS2362/2363/2365 fire when the other
 * side is bigint-ish): plain JS — relaxed only when 'any' participates. */
export const JS_ANY_OPERATOR_CODES: ReadonlySet<number> = new Set([2362, 2363, 2365]);

/** True for JavaScript source file NAMES (.js/.mjs/.cjs/.jsx) — the files
 * whose types come entirely from inference (checkJs + JSDoc) and whose JS
 * relaxation stance applies. */
export function isJsSourceFileName(fileName: string): boolean {
  // Only the final few code units can match. Keep the same expression so
  // unusual filenames retain its classification.
  return /\.(js|mjs|cjs|jsx)$/.test(fileName.slice(-6));
}
