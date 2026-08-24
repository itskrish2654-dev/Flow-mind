import { randomBytes } from "node:crypto";

import { cleanupExperiment, invokeAllowed } from "./harness";

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function main() {
  const samples = [];
  try {
    for (let index = 0; index < 5; index += 1) {
      const sample = invokeAllowed({ credential: `E50_PERF_FAKE_${randomBytes(24).toString("hex")}` });
      if (sample.response.ok !== true) throw new Error(`benchmark invocation ${index + 1} failed`);
      samples.push(sample);
    }
    const totals = samples.map((sample) => sample.totalMs);
    process.stdout.write(`${JSON.stringify({
      iterations: samples.length,
      stepTwoMedianMs: 5_160,
      medianTotalMs: percentile(totals, 0.5),
      highPercentileMs: percentile(totals, 0.95),
      incrementalMedianMs: percentile(totals, 0.5) - 5_160,
      medians: {
        networkSetupMs: percentile(samples.map((sample) => sample.networkSetupMs), 0.5),
        mockStartupMs: percentile(samples.map((sample) => sample.mockStartupMs), 0.5),
        gatewayStartupMs: percentile(samples.map((sample) => sample.gatewayStartupMs), 0.5),
        sandboxProcessMs: percentile(samples.map((sample) => sample.sandboxProcessMs), 0.5),
        cleanupMs: percentile(samples.map((sample) => sample.cleanupMs), 0.5),
      },
      peakSandboxMemoryBytes: Math.max(...samples.map((sample) => sample.sandboxPeakMemoryBytes ?? 0)),
      peakGatewayMemoryBytes: Math.max(...samples.map((sample) => sample.gatewayPeakMemoryBytes ?? 0)),
      cleanup: samples.every((sample) => sample.containersRemoved && sample.networksRemoved),
    }, null, 2)}\n`);
  } finally {
    cleanupExperiment();
  }
}

void main();
