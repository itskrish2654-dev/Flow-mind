import { readFile } from "node:fs/promises";

async function readLocalEnvironment() {
  const source = await readFile(".env.local", "utf8");
  return Object.fromEntries(
    source
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

const environment = await readLocalEnvironment();
const publicUrl = environment.NEXT_PUBLIC_SUPABASE_URL?.replace(
  /\/rest\/v1\/?$/,
  "",
);
const publicKey =
  environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  environment.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!publicUrl || !publicKey) {
  throw new Error("Missing public Supabase configuration in .env.local.");
}

const response = await fetch(
  `${publicUrl}/rest/v1/workflows?select=id&limit=1`,
  {
    headers: {
      apikey: publicKey,
      Authorization: `Bearer ${publicKey}`,
    },
  },
);

if (response.status === 401 || response.status === 403) {
  console.log(`PASS: anonymous workflow access was denied (${response.status}).`);
} else {
  const body = await response.json().catch(() => null);
  if (response.ok && Array.isArray(body) && body.length === 0) {
    console.log("PASS: anonymous workflow access returned zero rows.");
  } else if (response.ok && Array.isArray(body)) {
    console.error(
      `FAIL: anonymous workflow access returned ${body.length} row(s). Apply the RLS migration before launch.`,
    );
    process.exitCode = 1;
  } else {
    console.error(
      `FAIL: anonymous verification returned unexpected status ${response.status}.`,
    );
    process.exitCode = 1;
  }
}
