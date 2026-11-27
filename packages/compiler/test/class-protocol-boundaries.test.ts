import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("generic protocol dispatch without a concrete body calls the erased method", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-protocol-boundary-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(
      entry,
      `interface Live { value(): number; identity<T>(value: T): T; }
class Value implements Live {
  value(): number { return 1; }
  identity<T>(value: T): T { return value; }
}
function read(value: Live): number { return value.identity(3); }
console.log(read(new Value()));`,
    );
    const result = await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.ok).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an accessor satisfying a declared data member keeps the target live", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-accessor-data-member-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(
      entry,
      `interface Counter { size: number; label: string; }
function makeCounter(): Counter {
  let current = 1;
  return {
    get size(): number { return current; },
    set size(next: number) { current = next; },
    label: "counter",
  };
}
const counter = makeCounter();
counter.size = 10;
console.log(counter.size, counter.label, Object.keys(counter).join(","));`,
    );
    const result = await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.ok).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a data property satisfying a declared accessor keeps the target live", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-data-accessor-member-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(
      entry,
      `interface Live { readonly label: string; get size(): number; }
function makeLive(): Live { return { label: "counter", size: 3 }; }
console.log(makeLive().size);`,
    );
    const result = await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.ok).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// An anonymous object type or type alias a program class implements is the
// same structural view an interface spelling gets: the class instance keeps
// its identity and its prototype methods answer through the live view. A
// record layout would copy own fields only and lose `unsubscribe`.
for (const [name, disposable] of [
  ["type literal", `{ closed: boolean; unsubscribe(): void }`],
  ["type alias", `Disposable`],
] as const) {
  test(`a class instance through a structural ${name} keeps its methods`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "scriptc-literal-protocol-"));
    try {
      const entry = join(directory, "main.ts");
      writeFileSync(
        entry,
        `class Subscription {
  closed = false;
  unsubscribe() { this.closed = true; }
}
class Observable {
  subscribe(observer: { next(value: number): void; complete(): void }): Subscription {
    const sub = new Subscription();
    observer.next(1);
    observer.complete();
    return sub;
  }
}
${name === "type alias" ? `type Disposable = { closed: boolean; unsubscribe(): void };` : ""}
interface Source {
  subscribe(observer: { next(value: number): void; complete(): void }): ${disposable};
}
function collect(source: Source): number[] {
  const sub = source.subscribe({ next(_v) {}, complete() {} });
  sub.unsubscribe();
  return [];
}
collect(new Observable());`,
      );
      const irPath = join(directory, "program.ir");
      const result = await compile(entry, {
        outDir: directory,
        outPath: irPath,
        outputKind: "ir",
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const ir = JSON.parse(readFileSync(irPath, "utf8")) as {
        functions: { name: string; locals: { name: string; type: { kind: string } }[] }[];
      };
      const collect = ir.functions.find((f) => f.name === "collect");
      const sub = collect?.locals.find((l) => l.name === "sub");
      expect(sub?.type.kind).toBe("dyn");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
