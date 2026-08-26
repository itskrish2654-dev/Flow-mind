import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

const mode = process.argv[2] ?? "runtime";

function statusField(name) {
  return new RegExp(`^${name}:\\s*(.+)$`, "m").exec(readFileSync("/proc/self/status", "utf8"))?.[1]?.trim() ?? null;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function blockedConnect(host, port = 443) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(true);
    }, 600);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

if (mode === "runtime") {
  emit({
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    capabilities: statusField("CapEff"),
    noNewPrivileges: statusField("NoNewPrivs"),
    seccomp: statusField("Seccomp"),
    pidsMax: readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim(),
    memoryMax: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(),
    memorySwapMax: readFileSync("/sys/fs/cgroup/memory.swap.max", "utf8").trim(),
    cpuMax: readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(),
  });
} else if (mode === "filesystem") {
  let rootWriteDenied = false;
  try { writeFileSync("/step5a-should-not-write", "denied"); } catch { rootWriteDenied = true; }
  writeFileSync("/tmp/step5a-tmp-write", "ok");
  emit({ rootWriteDenied, tmpWritable: readFileSync("/tmp/step5a-tmp-write", "utf8") === "ok" });
} else if (mode === "temp-write") {
  writeFileSync("/tmp/step5a-cross-container", "must-not-persist");
  emit({ written: true });
} else if (mode === "temp-check") {
  let visible = true;
  try { readFileSync("/tmp/step5a-cross-container"); } catch { visible = false; }
  emit({ previousTempVisible: visible });
} else if (mode === "child") {
  const children = [];
  let denied = 0;
  for (let index = 0; index < 32; index += 1) {
    try {
      const child = spawn("/bin/sleep", ["2"], { stdio: "ignore" });
      child.once("error", () => { denied += 1; });
      children.push(child);
    } catch { denied += 1; }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const child of children) child.kill("SIGKILL");
  emit({ attempted: 32, startedAtMostPidLimit: children.filter((child) => child.pid).length <= 15, denied });
} else if (mode === "network") {
  const targets = [
    ["1.1.1.1", 443, "raw_public_ipv4"],
    ["2606:4700:4700::1111", 443, "raw_public_ipv6"],
    ["127.0.0.1", 443, "loopback"],
    ["10.0.0.1", 443, "rfc1918"],
    ["169.254.169.254", 80, "metadata"],
    ["172.17.0.1", 22, "host_lan"],
  ];
  const outcomes = {};
  for (const [host, port, label] of targets) outcomes[label] = await blockedConnect(host, port);
  emit(outcomes);
  if (!Object.values(outcomes).every(Boolean)) process.exitCode = 1;
} else if (mode === "sleep") {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  emit({ slept: true });
} else if (mode === "crash") {
  process.abort();
} else if (mode === "oom") {
  const allocations = [];
  while (true) allocations.push(Buffer.alloc(8 * 1024 * 1024, 1));
} else if (mode === "cpu") {
  while (true) Math.sqrt(Date.now());
} else {
  throw new Error("Unknown acceptance probe mode.");
}
