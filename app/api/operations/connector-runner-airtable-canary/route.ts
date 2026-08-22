import { handleAirtableAcceptancePost } from "@/lib/operations/airtable-create-record-acceptance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  return handleAirtableAcceptancePost(request);
}
