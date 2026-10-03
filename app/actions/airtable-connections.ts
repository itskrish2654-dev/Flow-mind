"use server";

import { revalidatePath } from "next/cache";

import { connectCustomerAirtable } from "@/lib/connectors/airtable/customer-connection";

export async function connectAirtable(personalAccessToken: string) {
  if (process.env.NODE_ENV === "production") {
    return { ok: false as const, error: "Airtable is not available in this pilot." };
  }
  if (typeof personalAccessToken !== "string") {
    return { ok: false as const, error: "Enter a valid Airtable personal access token." };
  }
  const result = await connectCustomerAirtable(personalAccessToken);
  if (result.ok) {
    revalidatePath("/connections");
    revalidatePath("/dashboard");
  }
  return result;
}
