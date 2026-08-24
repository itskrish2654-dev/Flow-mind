import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";

export type ContainerRuntimeName = "docker" | "podman";

export type RuntimeCommand = {
  executable: string;
  args: string[];
};

export function runtimeCommand(name: ContainerRuntimeName, args: string[], platform = process.platform): RuntimeCommand {
  if (name === "podman" && platform === "win32") {
    return { executable: "wsl.exe", args: ["-d", "Ubuntu", "--", "podman", ...args] };
  }
  return { executable: name, args };
}

export class ContainerRuntime {
  constructor(readonly name: ContainerRuntimeName, readonly workingDirectory: string) {}

  run(args: string[], options: { input?: string; timeoutMs?: number; maxBuffer?: number } = {}): SpawnSyncReturns<string> {
    const command = runtimeCommand(this.name, args);
    return spawnSync(command.executable, command.args, {
      cwd: this.workingDirectory,
      encoding: "utf8",
      input: options.input,
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      windowsHide: true,
    });
  }

  available() {
    const result = this.run(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 20_000 });
    return result.status === 0 && result.stdout.trim().length > 0;
  }

  runAsync(args: string[], options: { input?: string; timeoutMs?: number; maxBuffer?: number } = {}) {
    const command = runtimeCommand(this.name, args);
    return new Promise<SpawnSyncReturns<string>>((resolve) => {
      const child = spawn(command.executable, command.args, {
        cwd: this.workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024;
      let killedForSize = false;
      const append = (current: string, chunk: Buffer) => {
        const next = current + chunk.toString("utf8");
        if (Buffer.byteLength(next) > maxBuffer) {
          killedForSize = true;
          child.kill("SIGKILL");
        }
        return next.slice(0, maxBuffer);
      };
      child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60_000);
      child.once("close", (status, signal) => {
        clearTimeout(timer);
        resolve({ pid: child.pid ?? 0, output: [stdout, stderr], stdout, stderr, status, signal, error: killedForSize ? Object.assign(new Error("maxBuffer exceeded"), { code: "ENOBUFS" }) : undefined } as SpawnSyncReturns<string>);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ pid: child.pid ?? 0, output: [stdout, stderr], stdout, stderr, status: null, signal: null, error } as SpawnSyncReturns<string>);
      });
      child.stdin.end(options.input);
    });
  }
}
