import { redirect } from "next/navigation";

export default async function LegacyConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") next.set(key, value);
    else for (const item of value ?? []) next.append(key, item);
  }
  redirect(`/connections${next.size ? `?${next.toString()}` : ""}`);
}
