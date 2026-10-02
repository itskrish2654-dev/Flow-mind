import { getAuthenticatedContext } from "@/lib/auth";
import { KNOWLEDGE_LIMITS } from "@/lib/knowledge-core";
import { uploadCompanyKnowledge } from "@/lib/knowledge";
import { enforceRateLimit } from "@/lib/security/limits";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Request origin was not accepted." }, { status: 403 });
  }
  const auth = await getAuthenticatedContext();
  if (!auth) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (auth.membership.role === "member") return Response.json({ error: "Only company owners and admins can upload." }, { status: 403 });
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > KNOWLEDGE_LIMITS.fileBytes + 16_384) {
    return Response.json({ error: "Choose a file of 3 MB or less." }, { status: 413 });
  }
  try {
    await enforceRateLimit("knowledge-upload", [auth.user.id], { limit: 10, windowSeconds: 60 });
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Choose a file." }, { status: 400 });
    const result = await uploadCompanyKnowledge(file);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Upload failed." },
      { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
