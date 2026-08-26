import { connect } from "node:tls";

const scenario = process.argv[2] ?? "canonical";
const host = "api.hubapi.com";
const port = scenario === "wrong-port" ? 444 : 443;
const servername = scenario === "wrong-sni" ? "wrong.example" : scenario === "missing-sni" ? undefined : host;

const result = await new Promise((resolve) => {
  const socket = connect({ host, port, servername, rejectUnauthorized: scenario === "canonical" });
  const timer = setTimeout(() => {
    socket.destroy();
    resolve({ ok: false, outcome: "timeout" });
  }, 4_000);
  socket.once("secureConnect", () => {
    clearTimeout(timer);
    const certificate = socket.getPeerCertificate();
    const evidence = {
      ok: scenario === "canonical" && socket.authorized === true,
      outcome: "secure_connect",
      authorized: socket.authorized === true,
      authorizationError: socket.authorizationError ? "present" : null,
      sni: servername ?? null,
      certificateSubject: certificate?.subject?.CN ?? null,
      certificateAltNames: certificate?.subjectaltname ?? null,
      applicationBytesSent: 0,
    };
    socket.end();
    resolve(evidence);
  });
  socket.once("error", () => {
    clearTimeout(timer);
    resolve({ ok: false, outcome: "connection_rejected", sni: servername ?? null });
  });
});

process.stdout.write(`${JSON.stringify(result)}\n`);
if (scenario === "canonical" ? !result.ok : result.ok) process.exitCode = 1;
