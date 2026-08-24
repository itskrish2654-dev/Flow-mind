import { performance } from "node:perf_hooks";

import nock from "nock";

import {
  HUBSPOT_GET_CONTACT_CAPABILITY,
  executePinnedHubSpotGetContact,
  loadPinnedHubSpotAction,
} from "./adapter";

async function main() {
  const memoryBefore = process.memoryUsage().heapUsed;
  const loadStarted = performance.now();
  loadPinnedHubSpotAction();
  const loadMs = performance.now() - loadStarted;
  const memoryAfterLoad = process.memoryUsage().heapUsed;

  nock.disableNetConnect();
  nock("https://api.hubapi.com")
    .get(/\/crm\/v3\/objects\/contacts\/benchmark-contact/)
    .query(true)
    .reply(200, {
      id: "benchmark-contact",
      properties: { email: "benchmark@example.test" },
      archived: false,
    });

  const executionStarted = performance.now();
  try {
    await executePinnedHubSpotGetContact({
      capability: HUBSPOT_GET_CONTACT_CAPABILITY,
      props: { contactId: "benchmark-contact" },
      credential: Buffer.from("local-benchmark-placeholder"),
    });
  } finally {
    nock.cleanAll();
    nock.enableNetConnect();
  }
  const executionMs = performance.now() - executionStarted;
  const memoryAfterExecution = process.memoryUsage().heapUsed;

  process.stdout.write(
    `${JSON.stringify({
      loadMs: Number(loadMs.toFixed(2)),
      executionMs: Number(executionMs.toFixed(2)),
      loadHeapDeltaBytes: memoryAfterLoad - memoryBefore,
      totalHeapDeltaBytes: memoryAfterExecution - memoryBefore,
    })}\n`,
  );
}

void main().catch(() => {
  process.stderr.write("BENCHMARK_FAILED\n");
  process.exitCode = 1;
});
