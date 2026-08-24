import { randomBytes } from "node:crypto";

import { imageEvidence, invokeSandbox, sandboxRuntimeDescription } from "./harness";

function percentile(values: number[], percentileValue: number) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(percentileValue * ordered.length) - 1);
  return Number(ordered[index].toFixed(2));
}

function median(values: number[]) {
  return percentile(values, 0.5);
}

function main() {
  const samples = Array.from({ length: 7 }, () =>
    invokeSandbox({
      credential: `E50_BENCHMARK_${randomBytes(32).toString("hex")}`,
    }),
  );
  if (!samples.every((sample) => sample.response.ok && sample.containerRemoved)) {
    throw new Error("A disposable sandbox benchmark invocation failed.");
  }

  const total = samples.map((sample) => sample.totalMs);
  const cleanup = samples.map((sample) => sample.cleanupMs);
  const moduleLoad = samples.map((sample) => sample.response.meta?.moduleLoadMs ?? 0);
  const execution = samples.map((sample) => sample.response.meta?.executionMs ?? 0);
  const processDuration = samples.map((sample) => sample.response.meta?.processMs ?? 0);
  const boundaryOverhead = samples.map((sample, index) =>
    Math.max(0, sample.totalMs - sample.cleanupMs - processDuration[index]),
  );
  const peakMemory = samples.map((sample) => sample.response.meta?.peakMemoryBytes ?? 0);
  const image = imageEvidence();

  process.stdout.write(
    `${JSON.stringify({
      iterations: samples.length,
      runtime: sandboxRuntimeDescription(),
      totalMedianMs: median(total),
      totalP95ishMs: percentile(total, 0.95),
      moduleLoadMedianMs: median(moduleLoad),
      executionMedianMs: median(execution),
      sandboxProcessMedianMs: median(processDuration),
      containerBoundaryMedianMs: median(boundaryOverhead),
      cleanupMedianMs: median(cleanup),
      peakMemoryP95ishBytes: percentile(peakMemory, 0.95),
      imageSizeBytes: image.sizeBytes,
      imageDigest: image.digest,
    })}\n`,
  );
}

main();
