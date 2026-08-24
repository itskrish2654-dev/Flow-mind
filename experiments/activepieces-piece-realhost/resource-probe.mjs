const mode = process.argv[2];

if (mode === "crash") process.exit(23);
if (mode === "hold") setTimeout(() => process.exit(0), 5_000);
if (mode === "oom") {
  const allocations = [];
  while (true) allocations.push(Buffer.alloc(16 * 1024 * 1024, 0x5a));
}
if (mode !== "hold") process.exit(2);
