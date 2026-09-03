import { DockerEngineClient } from "./docker-client.mjs";
import { DockerPieceContainerEngine } from "./docker-piece-container-engine.mjs";
import { EgressBrokerClient } from "./egress-broker-client.mjs";
import { EGRESS_BROKER_CONTAINER_NAME, EGRESS_BROKER_SOCKET_PATH } from "./egress-broker-constants.mjs";
import { SUPERVISOR_DEFAULT_CONCURRENCY, SUPERVISOR_SOCKET_PATH } from "./supervisor-constants.mjs";
import { startSupervisorServer } from "./supervisor-server.mjs";
import { PieceSupervisorService } from "./supervisor-service.mjs";

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main() {
  const docker = new DockerEngineClient();
  const brokerClient = new EgressBrokerClient({
    socketPath: process.env.PIECE_EGRESS_BROKER_SOCKET_PATH ?? EGRESS_BROKER_SOCKET_PATH,
  });
  const engine = new DockerPieceContainerEngine({
    docker,
    brokerClient,
    logger: log,
    selfContainerName: process.env.PIECE_SUPERVISOR_CONTAINER_NAME,
    brokerContainerName: process.env.PIECE_EGRESS_BROKER_CONTAINER_NAME ?? EGRESS_BROKER_CONTAINER_NAME,
  });
  const service = new PieceSupervisorService({
    engine,
    concurrencyLimit: process.env.PIECE_SUPERVISOR_CONCURRENCY ?? SUPERVISOR_DEFAULT_CONCURRENCY,
    logger: log,
  });
  const supervisor = await startSupervisorServer({
    service,
    engine,
    socketPath: process.env.PIECE_SUPERVISOR_SOCKET_PATH ?? SUPERVISOR_SOCKET_PATH,
    logger: log,
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await supervisor.stop();
      process.exitCode = 0;
    } catch {
      process.stderr.write(`${JSON.stringify({ event: "piece_supervisor_shutdown_failed", errorCode: "SUPERVISOR_UNAVAILABLE" })}\n`);
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

main().catch(() => {
  process.stderr.write(`${JSON.stringify({ event: "piece_supervisor_start_failed", errorCode: "SUPERVISOR_UNAVAILABLE" })}\n`);
  process.exitCode = 1;
});
