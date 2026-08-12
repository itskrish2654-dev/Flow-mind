import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

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
const publicKey = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!publicUrl || !publicKey) {
  throw new Error("Missing public Supabase configuration in .env.local.");
}

const workflowResponse = await fetch(
  `${publicUrl}/rest/v1/workflows?select=id&limit=1`,
  {
    headers: {
      apikey: publicKey,
      Authorization: `Bearer ${publicKey}`,
    },
  },
);

if (workflowResponse.status === 401 || workflowResponse.status === 403) {
  console.log(`PASS: anonymous workflow access was denied (${workflowResponse.status}).`);
} else {
  const body = await workflowResponse.json().catch(() => null);
  if (workflowResponse.ok && Array.isArray(body) && body.length === 0) {
    console.log("PASS: anonymous workflow access returned zero rows.");
  } else if (workflowResponse.ok && Array.isArray(body)) {
    console.error(
      `FAIL: anonymous workflow access returned ${body.length} row(s). Apply the RLS migration before launch.`,
    );
    process.exitCode = 1;
  } else {
    console.error(
      `FAIL: anonymous verification returned unexpected status ${workflowResponse.status}.`,
    );
    process.exitCode = 1;
  }
}

const headers = {
  apikey: publicKey,
  Authorization: `Bearer ${publicKey}`,
  "Content-Type": "application/json",
};

const executionReadResponse = await fetch(
  `${publicUrl}/rest/v1/workflow_executions?select=id&limit=1`,
  { headers },
);
if ([401, 403].includes(executionReadResponse.status)) {
  console.log(
    `PASS: anonymous execution-log reads were denied (${executionReadResponse.status}).`,
  );
} else {
  console.error(
    `FAIL: anonymous execution-log read returned ${executionReadResponse.status}.`,
  );
  process.exitCode = 1;
}

const invalidWorkflowId = randomUUID();
const invalidInsertResponse = await fetch(
  `${publicUrl}/rest/v1/workflow_executions`,
  {
    method: "POST",
    headers,
    body: JSON.stringify({
      workflow_id: invalidWorkflowId,
      input_data: { test: true },
      output_data: { status: "processed" },
    }),
  },
);
if ([401, 403].includes(invalidInsertResponse.status)) {
  console.log(
    `PASS: anonymous execution insert for an invalid project was denied (${invalidInsertResponse.status}).`,
  );
} else {
  console.error(
    `FAIL: anonymous execution insert for an invalid project returned ${invalidInsertResponse.status}.`,
  );
  process.exitCode = 1;
}

const publicLookupResponse = await fetch(
  `${publicUrl}/rest/v1/rpc/get_public_workflow`,
  {
    method: "POST",
    headers,
    body: JSON.stringify({ p_workflow_id: invalidWorkflowId }),
  },
);
const publicLookupBody = await publicLookupResponse.json().catch(() => null);
if (
  publicLookupResponse.ok &&
  Array.isArray(publicLookupBody) &&
  publicLookupBody.length === 0
) {
  console.log("PASS: public form lookup exposes no row for an invalid project.");
} else {
  console.error(
    `FAIL: public form lookup returned unexpected status ${publicLookupResponse.status}.`,
  );
  process.exitCode = 1;
}
