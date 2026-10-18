/** Native tool invocation without a JavaScript host or shell command construction. */
import type { NativeOptimization } from "./optimization.js";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import type { NativeHelperSpec, NativeTargetSpec } from "./targets.js";
import {
  nativePartitionPaths,
  validateNativeCodegenVersion,
  type NativeCodegenOutputKind,
} from "./native-codegen-core.js";

export function runNativeTool(
  executable: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): string {
  return execFileSync(executable, args, {
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 64 * 1024 * 1024,
    cwd: cwd ?? process.cwd(),
    env: env ?? process.env,
  });
}

export function requireNativeArtifact(path: string): void {
  const info = statSync(path);
  if (!info.isFile() || info.size === 0)
    throw new Error(`native tool produced no artifact: ${path}`);
}

export function emitNativeObject(options: {
  executable: string;
  packageRoot: string;
  compilerVersion: string;
  target: NativeTargetSpec;
  helper: NativeHelperSpec;
  inputPath: string;
  outputPath: string;
  sourcePath: string;
  optimization: NativeOptimization;
  outputKind?: NativeCodegenOutputKind;
  /** Program partitions, written to nativePartitionPaths(outputPath). */
  partitions?: number;
  /** Private directory where the helper reuses partition artifacts. */
  partitionCache?: string;
  /** Worker threads for partition compilation; unset follows SCRIPTC_JOBS,
   * then the host's hardware concurrency. */
  jobs?: number;
}): string[] {
  verifyNativeHelper(options);
  const outputs = nativePartitionPaths(options.outputPath, options.partitions ?? 1);
  runNativeTool(options.executable, [
    "emit",
    "--input",
    options.inputPath,
    ...outputs.flatMap((output) => ["--output", output]),
    "--filetype",
    options.outputKind ?? "obj",
    "--target",
    options.target.llvmTriple,
    "--opt-level",
    options.optimization === "dev" ? "0" : "2",
    "--relocation-model",
    options.target.relocationModel,
    "--diagnostic-format",
    "json",
    "--source-path",
    options.sourcePath,
    ...(options.partitionCache === undefined || outputs.length < 2
      ? []
      : ["--cache-dir", options.partitionCache]),
    ...(options.jobs === undefined ? [] : ["--jobs", String(options.jobs)]),
  ]);
  for (const output of outputs) requireNativeArtifact(output);
  return outputs;
}

/** Verify installed identity even when a caller can reuse a cached object. */
export function verifyNativeHelper(options: {
  executable: string;
  packageRoot: string;
  compilerVersion: string;
  target: NativeTargetSpec;
  helper: NativeHelperSpec;
}): void {
  const identity = JSON.parse(readFileSync(options.packageRoot + "/package.json", "utf8")) as {
    name: string;
    version: string;
  };
  if (
    identity.name !== options.helper.packageName ||
    identity.version !== options.compilerVersion
  ) {
    throw new Error(
      `LLVM helper package mismatch: expected ${options.helper.packageName}@${options.compilerVersion}`,
    );
  }
  const version = JSON.parse(
    runNativeTool(options.executable, ["version", "--format=json"]),
  ) as Record<string, unknown>;
  validateNativeCodegenVersion(version, options.target, options.helper, options.compilerVersion);
}
