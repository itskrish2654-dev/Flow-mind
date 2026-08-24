import { connect } from "node:net";

const target = process.env.E50_DIRECT_PROBE_TARGET;
if (typeof target !== "string" || target.length < 1 || target.length > 255) process.exit(2);
const socket = connect({ host: target, port: 443 });
let finished = false;
const finish = (blocked) => {
  if (finished) return;
  finished = true;
  socket.destroy();
  process.stdout.write(`${JSON.stringify({ blocked })}\n`);
};
socket.setTimeout(1_000, () => finish(true));
socket.once("connect", () => finish(false));
socket.once("error", () => finish(true));
socket.once("close", () => finish(true));
