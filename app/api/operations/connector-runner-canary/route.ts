import { handleConnectorRunnerCanaryPost } from "@/lib/operations/connector-runner-canary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  return handleConnectorRunnerCanaryPost(request);
}
