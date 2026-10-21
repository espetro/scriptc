import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileSource(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-diag-hint-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, source);
    return await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("SC2020 diagnostic hint reports checker-narrowed type and unlowerable storage arm", async () => {
  const source = `
    type V = number | bigint | string | null | Uint8Array | boolean;
    function f(arr: V[], i: number) {
      const v = arr[i];
      if (typeof v === "number") {
        BigInt(v);
      }
    }
    f([], 0);
  `;
  const result = await compileSource(source);
  expect(result.ok).toBe(false);
  const sc2020 = result.diagnostics.find((d) => d.code === "SC2020");
  expect(sc2020).toBeDefined();
  expect(sc2020?.message).toContain("BigInt of");
  expect(sc2020?.hint).toBe(
    "string, number, boolean, and bigint arguments are supported; narrowed type is number; unlowerable storage arm: Uint8Array",
  );
});

test("SC2020 diagnostic hint reports default supported message when types match", async () => {
  const source = `
    // @ts-expect-error
    BigInt(new Uint8Array(0));
  `;
  const result = await compileSource(source);
  expect(result.ok).toBe(false);
  const sc2020 = result.diagnostics.find((d) => d.code === "SC2020");
  expect(sc2020).toBeDefined();
  expect(sc2020?.hint).toBe("string, number, boolean, and bigint arguments are supported");
});
