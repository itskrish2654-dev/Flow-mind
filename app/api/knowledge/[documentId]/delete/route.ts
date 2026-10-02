import { getAuthenticatedContext } from "@/lib/auth";
import { deleteCompanyKnowledge } from "@/lib/knowledge";
import { enforceRateLimit } from "@/lib/security/limits";

export async function POST(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Request origin was not accepted." }, { status: 403 });
  }
  const auth = await getAuthenticatedContext();
  if (!auth) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (auth.membership.role === "member") return Response.json({ error: "Only company owners and admins can remove documents." }, { status: 403 });
  try {
    await enforceRateLimit("knowledge-delete", [auth.user.id], { limit: 20, windowSeconds: 60 });
    await deleteCompanyKnowledge((await params).documentId);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Deletion failed." },
      { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
