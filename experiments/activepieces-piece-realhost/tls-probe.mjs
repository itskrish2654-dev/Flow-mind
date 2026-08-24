import { connect } from "node:tls";

const hostname = "api.hubapi.com";
const connectHost = process.env.E50_TLS_CONNECT_HOST ?? hostname;
if (connectHost !== hostname && connectHost !== "e50-hubspot-gateway") {
  process.stdout.write(`${JSON.stringify({ ok: false, errorCategory: "EGRESS_DESTINATION_DENIED" })}\n`);
  process.exit(2);
}
const timeout = setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, errorCategory: "EGRESS_TIMEOUT" })}\n`);
  process.exit(1);
}, 5_000);

const socket = connect({ host: connectHost, port: 443, servername: hostname, rejectUnauthorized: true });
socket.once("secureConnect", () => {
  clearTimeout(timeout);
  const certificate = socket.getPeerCertificate();
  process.stdout.write(`${JSON.stringify({
    ok: socket.authorized,
    hostname,
    port: 443,
    protocol: socket.getProtocol(),
    authorized: socket.authorized,
    certificateSubject: certificate?.subject?.CN ?? null,
    applicationDataSent: false,
  })}\n`);
  socket.destroy();
});
socket.once("error", () => {
  clearTimeout(timeout);
  process.stdout.write(`${JSON.stringify({ ok: false, errorCategory: "EGRESS_CONNECTION_FAILED" })}\n`);
  process.exit(1);
});
