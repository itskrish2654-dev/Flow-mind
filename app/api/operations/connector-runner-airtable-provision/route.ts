import { handleAirtableProvisionPost } from "@/lib/operations/airtable-provision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return Response.json({ error: "Not found." }, { status: 404 });
  return handleAirtableProvisionPost(request);
}
