"use server";

import { revalidatePath } from "next/cache";

import { connectCustomerAirtable } from "@/lib/connectors/airtable/customer-connection";

export async function connectAirtable(personalAccessToken: string) {
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
