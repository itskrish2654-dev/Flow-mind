import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";

const mode = process.argv[2] ?? "unknown";

function attempt(factory, timeoutMs = 900) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = factory();
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ blocked: !connected });
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("secureConnect", () => finish(true));
    socket.once("connect", () => {
      if (socket.encrypted !== true) finish(true);
    });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

const tcp = (host, port) => attempt(() => connectTcp({ host, port }));
const tls = (servername) => attempt(() => connectTls({ host: "api.hubapi.com", port: 443, servername, rejectUnauthorized: false }));

async function connectionLimit() {
  const sockets = [];
  let connected = 0;
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
    const socket = connectTls({ host: "api.hubapi.com", port: 443, servername: "api.hubapi.com", rejectUnauthorized: false });
    sockets.push(socket);
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    socket.once("secureConnect", () => { connected += 1; setTimeout(finish, 700); });
    socket.once("error", finish);
    socket.setTimeout(900, finish);
  })));
  for (const socket of sockets) socket.destroy();
  return { blocked: connected <= 2, connected, requested: 4 };
}

async function directMatrix() {
  const cases = [
    ["unapprovedHostname", () => tcp("unapproved.example", 443)],
    ["publicRawIp", () => tcp("1.1.1.1", 443)],
    ["publicRawIpv6", () => tcp("2606:4700:4700::1111", 443)],
    ["loopback", () => tcp("127.0.0.1", 9)],
    ["sandboxPeer", () => tcp("10.251.0.254", 443)],
    ["private10", () => tcp("10.0.0.1", 443)],
    ["private172", () => tcp("172.16.0.1", 443)],
    ["private192", () => tcp("192.168.1.1", 443)],
    ["metadata", () => tcp("169.254.169.254", 80)],
    ["ipv6Loopback", () => tcp("::1", 443)],
    ["ipv6Ula", () => tcp("fc00::1", 443)],
    ["ipv6LinkLocal", () => tcp("fe80::1", 443)],
    ["wrongSni", () => tls("wrong.example")],
    ["noSni", () => tls(undefined)],
    ["wrongPort", () => tcp("api.hubapi.com", 444)],
    ["malformedTls", () => new Promise((resolve) => {
      const socket = connectTcp({ host: "api.hubapi.com", port: 443 });
      let settled = false;
      const finish = (blocked) => { if (!settled) { settled = true; socket.destroy(); resolve({ blocked }); } };
      socket.once("connect", () => socket.write("not tls"));
      socket.once("error", () => finish(true));
      socket.once("close", () => finish(true));
      socket.setTimeout(900, () => finish(true));
    })],
  ];
  const output = {};
  for (const [name, execute] of cases) output[name] = await execute();
  output.connectionLimit = await connectionLimit();
  return output;
}

let result;
switch (mode) {
  case "matrix": result = await directMatrix(); break;
  case "unapproved_hostname": result = await tcp("unapproved.example", 443); break;
  case "public_raw_ip": result = await tcp("1.1.1.1", 443); break;
  case "loopback": result = await tcp("127.0.0.1", 9); break;
  case "peer": result = await tcp("10.251.0.254", 443); break;
  case "private_10": result = await tcp("10.0.0.1", 443); break;
  case "private_172": result = await tcp("172.16.0.1", 443); break;
  case "private_192": result = await tcp("192.168.1.1", 443); break;
  case "metadata": result = await tcp("169.254.169.254", 80); break;
  case "ipv6_loopback": result = await tcp("::1", 443); break;
  case "ipv6_ula": result = await tcp("fc00::1", 443); break;
  case "ipv6_linklocal": result = await tcp("fe80::1", 443); break;
  case "wrong_sni": result = await tls("wrong.example"); break;
  case "no_sni": result = await tls(undefined); break;
  case "wrong_port": result = await tcp("api.hubapi.com", 444); break;
  case "malformed": result = await attempt(() => { const socket = connectTcp({ host: "api.hubapi.com", port: 443 }); socket.once("connect", () => socket.write("not tls")); return socket; }); break;
  default: result = { blocked: true };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
