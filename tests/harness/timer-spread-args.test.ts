/* Spread arguments in timer calls: the trailing callback positions lower
 * (the differential corpus timer-spread-trailing-args.ts runs them), while
 * a spread in the callback or delay position and a spread clear argument
 * keep the SC1090 refusal. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

async function diagnosticsOf(source: string): Promise<string[]> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-timer-spread-"));
  const entry = join(outDir, "main.ts");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(false);
  if (result.ok) return [];
  return result.diagnostics.map((d) => `${d.code} ${d.message}`);
}

test("a spread in the callback or delay position refuses", async () => {
  const messages = await diagnosticsOf(`setTimeout(...[() => {}, 1] as [() => void, number]);
setTimeout(() => {}, ...[1, "x"] as [number, string]);
setInterval(...[() => {}, 1] as [() => void, number]);
setImmediate(...[() => {}] as [() => void]);
`);
  expect(messages).toHaveLength(4);
  for (const message of messages) {
    expect(message).toMatch(
      /SC1090 spread arguments in the callback( or delay)? position .* is not supported yet/,
    );
  }
});

test("a spread clear argument refuses", async () => {
  const messages = await diagnosticsOf(`const imm = setImmediate(() => {});
clearTimeout(...[1] as [number]);
clearInterval(...[1] as [number]);
clearImmediate(...[imm] as [ReturnType<typeof setImmediate>]);
`);
  expect(messages).toHaveLength(3);
  for (const message of messages) {
    expect(message).toMatch(/SC1090 spread arguments in a clear call is not supported yet/);
  }
});
