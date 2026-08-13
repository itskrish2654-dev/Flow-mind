import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { error } = await createAdminClient()
      .from("operational_maintenance_runs")
      .select("id", { head: true, count: "exact" })
      .limit(1);
    if (error) throw new Error("database_unavailable");
    return Response.json(
      {
        status: "ok",
        database: "ok",
        release: (process.env.VERCEL_GIT_COMMIT_SHA || "local").slice(0, 12),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unavailable", database: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

