/* NodeJS.ReadStream / NodeJS.WriteStream under an adopted @types/node
 * (issue: @types/node stream class declarations have no lowering mapping).
 *
 * npkill's UiService declares its stdin field `NodeJS.ReadStream` — the
 * @types/node global-namespace interface that is process.stdin's declared
 * type. With the project's own @types/node adopted (a tsconfig present),
 * the bundled fallback declarations stand down, the interface inherits
 * net.Socket, and no static shape exists: the type now maps to the checked
 * dynamic, the identical representation the fallback's process.stdio
 * value produces. Terminal members (isTTY/setRawMode) keep their
 * dedicated lowering; every other member crosses the dynamic boundary.
 *
 * The fs.ReadStream / fs.WriteStream class annotations map to the stream
 * lowering surface under both provenances (the runtime streams); the
 * @types-adopted spelling guards that branch here.
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compile } from "../src/index.js";

const repoRoot = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "scriptc-node-types-read-stream-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function compileIn(project: string, source: string): Promise<string[]> {
  const dir = join(scratch, project);
  mkdirSync(join(dir, "node_modules/@types"), { recursive: true });
  cpSync(join(repoRoot, "node_modules/@types/node"), join(dir, "node_modules/@types/node"), {
    recursive: true,
    dereference: true,
  });
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  const entry = join(dir, "main.ts");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    outDir: dir,
    outPath: join(dir, "main.ir.json"),
    outputKind: "ir",
  });
  return result.ok ? [] : result.diagnostics.map((d) => `${d.code}: ${d.message}`);
}

test("NodeJS.ReadStream (process.stdin's @types/node type) lowers the npkill UiService shape", async () => {
  expect(
    await compileIn(
      "ui-service",
      `export class UiService {
  stdin: NodeJS.ReadStream = process.stdin;
  setRawMode(set = true): void {
    if (this.stdin.isTTY) {
      this.stdin.setRawMode(set);
    }
    process.stdin.resume();
  }
  pause(): void {
    this.stdin.pause();
  }
  onData(cb: (chunk: Uint8Array) => void): void {
    this.stdin.on("data", cb);
  }
  isTerminal(): boolean {
    return this.stdin.isTTY === true;
  }
}
new UiService().setRawMode(false);
`,
    ),
  ).toEqual([]);
});

test("fs.ReadStream / fs.WriteStream annotations from @types/node map to the stream surface", async () => {
  expect(
    await compileIn(
      "fs-stream-annotations",
      `import { ReadStream, WriteStream, createReadStream } from "node:fs";

export class Service {
  private input: ReadStream;
  private output: WriteStream;
  constructor(input: ReadStream, output: WriteStream) {
    this.input = input;
    this.output = output;
  }
  progress(): number {
    return this.input.bytesRead + this.output.bytesWritten;
  }
  pending(): boolean {
    return this.input.pending || this.output.pending;
  }
  close(): void {
    this.input.close();
    this.output.close();
  }
}

export function open(): ReadStream {
  return createReadStream("x");
}
`,
    ),
  ).toEqual([]);
});
