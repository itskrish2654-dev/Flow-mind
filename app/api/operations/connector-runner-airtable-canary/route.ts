import { handleAirtableAcceptancePost } from "@/lib/operations/airtable-create-record-acceptance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return Response.json({ error: "Not found." }, { status: 404 });
  return handleAirtableAcceptancePost(request);
}
