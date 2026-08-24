import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const expectedHash = process.env.E50_EXPECTED_CREDENTIAL_SHA256 ?? "";
const certificate = readFileSync("/mock/server.crt");
const privateKey = readFileSync("/mock/server.key");

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), connection: "close" });
  response.end(payload);
}

createServer({ cert: certificate, key: privateKey }, (request, response) => {
  const match = /^\/crm\/v3\/objects\/contacts\/([A-Za-z0-9_-]+)/.exec(request.url ?? "");
  if (request.method !== "GET" || !match) return sendJson(response, 404, { status: "not_found" });
  const authorization = request.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const accepted = token.length > 0 && createHash("sha256").update(token).digest("hex") === expectedHash;
  if (!accepted) return sendJson(response, 401, { status: "rejected" });
  const contactId = match[1];
  if (contactId === "redirect") {
    response.writeHead(302, { location: "https://unapproved.example/escaped", connection: "close" });
    response.end();
    return;
  }
  if (contactId === "oversized") {
    return sendJson(response, 200, { id: contactId, properties: { payload: "x".repeat(256 * 1024) }, archived: false });
  }
  if (contactId === "timeout") return;
  sendJson(response, 200, {
    id: contactId,
    properties: { email: "reader@example.test", firstname: "Casey", credentialAccepted: "true" },
    archived: false
  });
}).listen(443, "0.0.0.0");
