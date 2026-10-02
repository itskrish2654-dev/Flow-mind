"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  FileSpreadsheet,
  Link2Off,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import { connectAirtable } from "@/app/actions/airtable-connections";
import { disconnectConnector } from "@/app/actions/connections";
import { AccessibleDialog } from "@/components/accessible-dialog";
import { GoogleSpreadsheetPicker } from "@/components/google-spreadsheet-picker";
import { getConnectorOnboarding } from "@/lib/capability-registry";
import type { ConnectionProvider, ConnectionView } from "@/lib/connectors/connection-view";

type ProviderAvailability = { slack: boolean; notion: boolean; google: boolean };

const providerCopy: Record<ConnectionProvider, {
  name: string;
  description: string;
  connectLabel: string;
  operation: string;
}> = {
  slack: {
    name: "Slack",
    description: "Trigger loops from channel messages and send updates back to your team.",
    connectLabel: "Connect Slack",
    operation: "send_channel_message",
  },
  notion: {
    name: "Notion",
    description: "Create and update workspace content from your loops.",
    connectLabel: "Connect Notion",
    operation: "update_item",
  },
  google: {
    name: "Google accounts",
    description: "Search recent mail and send exact approved emails through your Google account.",
    connectLabel: "Connect Gmail",
    operation: "reply_to_email",
  },
  airtable: {
    name: "Airtable",
    description: "Save a personal access token for future Airtable record actions.",
    connectLabel: "Connect Airtable",
    operation: "",
  },
  hubspot: {
    name: "HubSpot",
    description: "Use an existing authorized HubSpot account for the accepted contact lookup test.",
    connectLabel: "HubSpot onboarding unavailable",
    operation: "get_contact",
  },
};

function ProviderIcon({ provider }: { provider: ConnectionProvider }) {
  if (provider === "slack") {
    return (
      <span aria-hidden="true" className="relative grid size-10 shrink-0 grid-cols-2 gap-0.5 rounded-xl border border-[#e4ddd2] bg-white p-2 shadow-sm">
        <span className="rounded-full rounded-br-sm bg-[#36c5f0]" />
        <span className="rounded-full rounded-bl-sm bg-[#2eb67d]" />
        <span className="rounded-full rounded-tr-sm bg-[#e01e5a]" />
        <span className="rounded-full rounded-tl-sm bg-[#ecb22e]" />
      </span>
    );
  }
  if (provider === "notion") {
    return (
      <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl border-2 border-slate-900 bg-white font-serif text-xl font-black text-slate-950 shadow-sm">N</span>
    );
  }
  if (provider === "airtable") {
    return (
      <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[#e4ddd2] bg-white text-lg font-bold text-[#176b87] shadow-sm">A</span>
    );
  }
  if (provider === "hubspot") {
    return (
      <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[#e4ddd2] bg-white text-lg font-bold text-[#ff5c35] shadow-sm">H</span>
    );
  }
  return (
    <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[#e4ddd2] bg-white text-xl font-bold shadow-sm">
      <span className="bg-gradient-to-br from-blue-600 via-red-500 to-amber-500 bg-clip-text text-transparent">G</span>
    </span>
  );
}

function statusDetails(status: ConnectionView["status"], verification: ConnectionView["verification"] = "provider_verified") {
  if (status === "connected" && verification === "locally_configured") {
    return {
      label: "Connected",
      health: "Locally configured",
      classes: "border-sky-200 bg-sky-50 text-sky-700",
      dot: "bg-sky-500",
    };
  }
  if (status === "connected") {
    return {
      label: "Connected",
      health: "Healthy",
      classes: "border-emerald-200 bg-emerald-50 text-emerald-700",
      dot: "bg-emerald-500",
    };
  }
  return {
    label: "Reconnect required",
    health: "Needs attention",
    classes: "border-amber-200 bg-amber-50 text-amber-800",
    dot: "bg-amber-500",
  };
}

function checkedDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently checked";
  return `Checked ${new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: date.getUTCFullYear() === new Date().getUTCFullYear() ? undefined : "numeric",
    timeZone: "UTC",
  }).format(date)}`;
}

function connectionFreshness(connection: ConnectionView) {
  if (connection.verification === "locally_configured") {
    const checked = checkedDate(connection.lastCheckedAt).replace(/^Checked /, "Saved ");
    return checked === "Recently checked" ? "Saved recently" : checked;
  }
  return checkedDate(connection.lastCheckedAt);
}

function connectHref(provider: "slack" | "notion" | "google", returnPath: string, connectionId?: string) {
  const operation = providerCopy[provider].operation;
  const query = new URLSearchParams({ operation, return: returnPath });
  if (connectionId) query.set("connection", connectionId);
  else query.set("account", "add");
  const connectorId = provider === "google" ? "google_gmail" : provider;
  return `/api/connectors/oauth/${connectorId}/start?${query.toString()}`;
}

function sheetsConnectHref(returnPath: string, connectionId?: string) {
  const query = new URLSearchParams({ operation: "add_row", return: returnPath });
  if (connectionId) query.set("connection", connectionId);
  else query.set("account", "add");
  return `/api/connectors/oauth/google_sheets/start?${query.toString()}`;
}

function withConnectionResult(returnPath: string, connector: string) {
  const target = new URL(returnPath, "https://crazyloops.invalid");
  target.searchParams.set("connected", connector);
  return `${target.pathname}${target.search}`;
}

function providerFromConnector(connector: string | null): ConnectionProvider | null {
  if (connector === "airtable") return "airtable";
  if (connector === "hubspot") return "hubspot";
  if (connector === "slack" || connector === "notion") return connector;
  if (connector === "google" || connector?.startsWith("google_")) return "google";
  return null;
}

function providerOnboarding(provider: ConnectionProvider) {
  return getConnectorOnboarding(provider === "google" ? "google_gmail" : provider);
}

export function ConnectionsList({
  connections,
  successConnector,
  errorCode,
  providerAvailability,
  returnPath,
}: {
  connections: ConnectionView[];
  successConnector: string | null;
  errorCode: string | null;
  providerAvailability: ProviderAvailability;
  returnPath: string;
}) {
  const router = useRouter();
  const [managed, setManaged] = useState<ConnectionView | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectingProvider, setConnectingProvider] = useState<ConnectionProvider | null>(null);
  const [airtableDialogOpen, setAirtableDialogOpen] = useState(false);
  const [airtablePat, setAirtablePat] = useState("");
  const [airtableSubmitting, setAirtableSubmitting] = useState(false);
  const [airtableError, setAirtableError] = useState<string | null>(null);
  const [selectedSheets, setSelectedSheets] = useState<Record<string, { id: string; title: string; worksheets: Array<{ id: number; title: string }> }>>({});

  const byProvider = useMemo(() => {
    const result = new Map<ConnectionProvider, ConnectionView[]>();
    for (const connection of connections) {
      result.set(connection.provider, [...(result.get(connection.provider) ?? []), connection]);
    }
    return result;
  }, [connections]);
  const successProvider = providerFromConnector(successConnector);
  const successItems = successProvider ? byProvider.get(successProvider) ?? [] : [];
  const successConnection = successItems.length === 1 ? successItems[0] : null;
  const providers = (["airtable", "hubspot", "slack", "notion", "google"] as const).filter((provider) => byProvider.has(provider));
  const availableProviders = (["airtable", "slack", "notion", "google"] as const).filter(
    (provider) => !byProvider.has(provider) && providerOnboarding(provider)?.available,
  );

  async function submitAirtable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (airtableSubmitting) return;
    setAirtableSubmitting(true);
    setAirtableError(null);
    setMessage(null);
    const token = airtablePat;
    setAirtablePat("");
    const result = await connectAirtable(token);
    if (!result.ok) {
      setAirtableError(result.error === "Unauthorized" ? "Sign in again before connecting Airtable." : result.error);
      setAirtableSubmitting(false);
      return;
    }
    setAirtableDialogOpen(false);
    setAirtableSubmitting(false);
    if (returnPath.startsWith("/dashboard/projects/")) {
      router.push(withConnectionResult(returnPath, "airtable"));
      return;
    }
    setMessage("Airtable was saved securely. The token will be verified when an Airtable action runs.");
    router.refresh();
  }

  async function confirmDisconnect() {
    if (!managed || disconnecting) return;
    setDisconnecting(true);
    setError(null);
    const result = await disconnectConnector(managed.id);
    if (!result.ok) {
      setError("We couldn’t disconnect this account. Please try again.");
      setDisconnecting(false);
      return;
    }
    setMessage(`${managed.providerName} was disconnected.`);
    setManaged(null);
    setConfirmingDisconnect(false);
    setDisconnecting(false);
    router.refresh();
  }

  return (
    <>
      {successProvider && (
        <div role="status" aria-live="polite" className="mt-6 flex flex-col gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4 sm:flex-row sm:items-center">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white text-emerald-600 shadow-sm"><Check className="size-4" aria-hidden="true" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-emerald-950">{providerCopy[successProvider].name} connected</p>
            <p className="mt-0.5 truncate text-xs text-emerald-800">{successConnection?.accountLabel ?? "Your account"} is ready to use in your loops.</p>
          </div>
           <Link href={returnPath.startsWith("/dashboard/projects/") ? returnPath : "/dashboard"} className="inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold text-emerald-900 hover:text-emerald-700">{returnPath.startsWith("/dashboard/projects/") ? "Continue workflow" : "Use it in a workflow"} <ArrowRight className="size-3.5" aria-hidden="true" /></Link>
        </div>
      )}

      {errorCode && (
        <div role="alert" className="mt-6 flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-rose-600" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-rose-950">We couldn’t connect that app.</p>
            <p className="mt-1 text-xs leading-5 text-rose-800">The authorization request expired, was cancelled, or could not be completed. Try connecting again.</p>
          </div>
        </div>
      )}

      {message && <p role="status" className="mt-5 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</p>}

      <section className="mt-9" aria-labelledby="connected-title">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Connected</p>
            <h2 id="connected-title" className="mt-1 text-lg font-semibold tracking-[-0.02em] text-slate-950">Your app accounts</h2>
          </div>
          {connections.length > 0 && <p className="text-xs text-slate-500">{connections.length} account{connections.length === 1 ? "" : "s"}</p>}
        </div>

        {connections.length === 0 ? (
          <div className="mt-4 flex items-start gap-4 rounded-2xl border border-dashed border-[#d8caa8] bg-[#fffdfa] p-5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#fff2bd] text-[#8a6200]"><Plus className="size-4" aria-hidden="true" /></span>
            <div>
              <p className="text-sm font-semibold text-slate-900">No apps connected yet</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">Start with the tool your first workflow needs. You can connect another account at any time.</p>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-5">
            {providers.map((provider) => {
              const items = byProvider.get(provider) ?? [];
              const canAddAnother = (provider === "slack" || provider === "notion" || provider === "google")
                && Boolean(providerOnboarding(provider)?.available)
                && providerAvailability[provider];
              return (
                <div key={provider} className="overflow-hidden rounded-2xl border border-[#ded6ca] bg-[#fffdfa] shadow-[0_10px_32px_rgba(39,37,54,.035)]">
                  <div className="flex items-center gap-3 border-b border-[#eee8de] px-4 py-3.5 sm:px-5">
                    <ProviderIcon provider={provider} />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-base font-semibold tracking-[-0.02em] text-slate-950">{providerCopy[provider].name}</h3>
                      <p className="mt-0.5 text-xs leading-5 text-slate-500">{providerCopy[provider].description}</p>
                    </div>
                    {canAddAnother && (
                      <a
                        href={connectHref(provider, returnPath)}
                        onClick={() => setConnectingProvider(provider)}
                        aria-label={`Connect another ${providerCopy[provider].name} account`}
                        className="hidden min-h-11 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-slate-700 transition hover:bg-[#fff7dc] hover:text-slate-950 sm:inline-flex"
                      >
                        {connectingProvider === provider ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                        Connect another
                      </a>
                    )}
                  </div>
                  <div className="divide-y divide-[#eee8de]">
                    {items.map((connection) => {
                      const details = statusDetails(connection.status, connection.verification);
                      return (
                        <article key={connection.id} className="flex flex-col gap-3 px-4 py-4 transition hover:bg-[#fffaf0] sm:flex-row sm:items-center sm:px-5">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-slate-900">{connection.accountLabel}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${details.classes}`}>
                                <span className={`size-1.5 rounded-full ${details.dot}`} aria-hidden="true" />{details.label}
                              </span>
                              <span className="text-[10px] text-slate-500">{connectionFreshness(connection)}</span>
                              {connection.gmailIntakeStatus === "setting_up" && <span className="text-[10px] text-amber-700">Gmail work sync is setting up</span>}
                              {connection.gmailIntakeStatus === "needs_attention" && <span className="text-[10px] text-amber-700">Gmail work sync needs attention</span>}
                              {connection.usedByWorkflows > 0 && <span className="text-[10px] text-slate-500">Used by {connection.usedByWorkflows} workflow{connection.usedByWorkflows === 1 ? "" : "s"}</span>}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => { setManaged(connection); setConfirmingDisconnect(false); setError(null); }}
                            aria-label={`Manage ${connection.providerName} connection for ${connection.accountLabel}`}
                            className="inline-flex min-h-11 items-center justify-center gap-1.5 self-stretch rounded-xl border border-[#ded6ca] bg-white px-4 text-xs font-semibold text-slate-700 transition hover:border-[#c9b98f] hover:bg-[#fff8e3] focus-visible:ring-4 focus-visible:ring-[#f1c94b]/40 sm:self-auto"
                          >
                            Manage <ArrowRight className="size-3.5" aria-hidden="true" />
                          </button>
                        </article>
                      );
                    })}
                  </div>
                  {canAddAnother && (
                    <a href={connectHref(provider, returnPath)} aria-label={`Connect another ${providerCopy[provider].name} account`} className="flex min-h-12 items-center justify-center gap-2 border-t border-[#eee8de] text-xs font-semibold text-slate-700 hover:bg-[#fff7dc] sm:hidden">
                      <Plus className="size-3.5" aria-hidden="true" /> Connect another {providerCopy[provider].name} account
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {availableProviders.length > 0 && (
        <section className="mt-10" aria-labelledby="available-apps-title">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Available</p>
          <h2 id="available-apps-title" className="mt-1 text-lg font-semibold tracking-[-0.02em] text-slate-950">Connect an app</h2>
          <div className="mt-4 divide-y divide-[#e8e1d7] overflow-hidden rounded-2xl border border-[#ded6ca] bg-[#fffdfa]">
            {availableProviders.map((provider) => {
              const available = Boolean(providerOnboarding(provider)?.available)
                && (provider === "airtable" || providerAvailability[provider]);
              return (
                <article key={provider} className="flex flex-col gap-4 px-4 py-4 transition hover:bg-[#fffaf0] sm:flex-row sm:items-center sm:px-5">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <ProviderIcon provider={provider} />
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-950">{provider === "google" ? "Gmail" : providerCopy[provider].name}</h3>
                      <p className="mt-1 text-xs leading-5 text-slate-500">{providerCopy[provider].description}</p>
                    </div>
                  </div>
                  {provider === "airtable" ? (
                    <button
                      type="button"
                      onClick={() => { setAirtableDialogOpen(true); setAirtableError(null); setMessage(null); }}
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#d7aa2f] bg-[#fff7dc] px-4 text-xs font-semibold text-[#6f5100] transition hover:bg-[#fff2bd] focus-visible:ring-4 focus-visible:ring-[#f1c94b]/40"
                    >
                      <Plus className="size-3.5" aria-hidden="true" /> {providerCopy[provider].connectLabel}
                    </button>
                  ) : available ? (
                    <a
                      href={connectHref(provider, returnPath)}
                      onClick={() => setConnectingProvider(provider)}
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#d7aa2f] bg-[#fff7dc] px-4 text-xs font-semibold text-[#6f5100] transition hover:bg-[#fff2bd] focus-visible:ring-4 focus-visible:ring-[#f1c94b]/40"
                    >
                      {connectingProvider === provider ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                      {providerCopy[provider].connectLabel}
                    </a>
                  ) : (
                    <span className="inline-flex min-h-10 items-center justify-center rounded-full bg-[#f4f1eb] px-3 text-[10px] font-semibold text-slate-600">Temporarily unavailable</span>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      <section id="google-sheets" className="mt-10" aria-labelledby="google-sheets-title">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Selected files only</p>
        <h2 id="google-sheets-title" className="mt-1 text-lg font-semibold tracking-[-0.02em] text-slate-950">Google Sheets</h2>
        <p className="mt-2 max-w-2xl text-xs leading-5 text-slate-600">Gmail and Sheets use separate Google permissions. CrazyLoops can only use spreadsheets you explicitly choose with Google Picker; connecting an account does not grant access to your whole Drive.</p>
        <div className="mt-4 space-y-3">
          {connections.filter((connection) => connection.provider === "google" && connection.sheetsAccess && connection.status === "connected").map((connection) => (
            <article key={connection.id} className="rounded-2xl border border-[#ded6ca] bg-[#fffdfa] p-4 sm:p-5">
              <div className="flex items-center gap-3">
                <FileSpreadsheet className="size-5 shrink-0 text-[#8a6200]" aria-hidden="true" />
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-slate-950">{connection.accountLabel}</h3>
                  <p className="text-xs text-slate-500">Choose one spreadsheet to make it available in Ask and approved actions.</p>
                </div>
              </div>
              <div className="mt-4 max-w-md">
                <GoogleSpreadsheetPicker
                  connectionId={connection.id}
                  value={selectedSheets[connection.id]?.id ?? ""}
                  onSelected={(spreadsheet) => setSelectedSheets((current) => ({ ...current, [connection.id]: spreadsheet }))}
                />
              </div>
              {selectedSheets[connection.id] && (
                <div role="status" className="mt-3 text-xs leading-5 text-slate-700">
                  <p className="font-semibold">Selected: {selectedSheets[connection.id].title}</p>
                  <p>Worksheets: {selectedSheets[connection.id].worksheets.map((item) => item.title).join(", ") || "None available"}</p>
                </div>
              )}
              <a href={sheetsConnectHref(returnPath, connection.id)} className="mt-3 inline-flex min-h-10 items-center gap-2 text-xs font-semibold text-[#765600] underline underline-offset-4">
                <RefreshCw className="size-3.5" aria-hidden="true" /> Reconnect this account if file access expires
              </a>
            </article>
          ))}
          {connections.filter((connection) => connection.provider === "google" && (!connection.sheetsAccess || connection.status !== "connected")).map((connection) => (
            <article key={connection.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#ded6ca] bg-[#fffdfa] p-4">
              <p className="text-xs text-slate-700">{connection.accountLabel} needs separate Google Sheets permission before a file can be selected.</p>
              <a href={sheetsConnectHref(returnPath, connection.id)} className="inline-flex min-h-10 items-center rounded-xl border border-[#d7aa2f] bg-[#fff7dc] px-3 text-xs font-semibold text-[#6f5100]">Add Sheets access</a>
            </article>
          ))}
          {providerAvailability.google && (
            <a
              href={sheetsConnectHref(returnPath)}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#d7aa2f] bg-[#fff7dc] px-4 text-xs font-semibold text-[#6f5100] hover:bg-[#fff2bd]"
            >
              <Plus className="size-4" aria-hidden="true" /> Connect Google Sheets or add file access
            </a>
          )}
        </div>
      </section>

      <AccessibleDialog
        open={Boolean(managed)}
        onOpenChange={(open) => { if (!open && !disconnecting) setManaged(null); }}
        title={managed ? `Manage ${managed.providerName}` : "Manage connection"}
        description="Review connection health, permissions, workflow usage, or disconnect this account."
        side="right"
      >
        {managed && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-[#e4ddd2] px-5 pb-5 pt-6 pr-16">
              <div className="flex items-center gap-3">
                <ProviderIcon provider={managed.provider} />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-500">{managed.providerName}</p>
                  <h2 className="truncate text-lg font-semibold text-slate-950">{managed.accountLabel}</h2>
                </div>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl bg-[#f8f4ec] p-4">
                  <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Status</p>
                  <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
                    {managed.status === "connected" ? <CheckCircle2 className="size-4 text-emerald-600" /> : <AlertCircle className="size-4 text-amber-600" />}
                    {statusDetails(managed.status, managed.verification).health}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">{connectionFreshness(managed)}</p>
                </div>
                <div className="rounded-xl bg-[#f8f4ec] p-4">
                  <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Used by</p>
                  <p className="mt-2 text-sm font-semibold text-slate-900">{managed.usedByWorkflows} workflow{managed.usedByWorkflows === 1 ? "" : "s"}</p>
                  <p className="mt-1 text-xs text-slate-500">Current saved versions</p>
                </div>
              </div>

              <div className="mt-5 rounded-xl border border-[#e4ddd2] bg-white p-4">
                <p className="flex items-center gap-2 text-xs font-semibold text-slate-900"><ShieldCheck className="size-4 text-[#8a6200]" />What CrazyLoops can do</p>
                <p className="mt-2 text-xs leading-5 text-slate-600">{managed.permissionSummary}</p>
              </div>

              {(managed.provider === "slack" || managed.provider === "notion" || managed.provider === "google") && providerAvailability[managed.provider] && (
                <a
                  href={managed.providerName === "Google Sheets" ? sheetsConnectHref(returnPath, managed.id) : connectHref(managed.provider, returnPath, managed.id)}
                  aria-label={`Reconnect ${managed.providerName} account ${managed.accountLabel}`}
                  className="mt-6 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-[#d8caa8] bg-white px-4 text-xs font-semibold text-slate-700 transition hover:bg-[#fff8e3]"
                >
                  <RefreshCw className="size-3.5" aria-hidden="true" /> Reconnect {managed.providerName}
                </a>
              )}

              <div className="mt-8 border-t border-[#e4ddd2] pt-6">
                <p className="text-xs font-semibold text-slate-900">Disconnect account</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  {managed.usedByWorkflows > 0
                    ? `${managed.usedByWorkflows} workflow${managed.usedByWorkflows === 1 ? " uses" : "s use"} this connection and will require reconnection.`
                    : "CrazyLoops will remove its saved access to this account."}
                </p>
                {!confirmingDisconnect ? (
                  <button type="button" onClick={() => setConfirmingDisconnect(true)} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-semibold text-rose-700 transition hover:bg-rose-50">
                    <Link2Off className="size-4" aria-hidden="true" /> Disconnect {managed.providerName}
                  </button>
                ) : (
                  <div role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4">
                    <p className="text-xs font-semibold text-rose-950">Disconnect {managed.accountLabel}?</p>
                    <p className="mt-1 text-xs leading-5 text-rose-800">Existing workflows will remain saved, but connected steps cannot run until another account is selected.</p>
                    {error && <p className="mt-2 text-xs font-medium text-rose-800">{error}</p>}
                    <div className="mt-4 flex flex-wrap justify-end gap-2">
                      <button type="button" onClick={() => setConfirmingDisconnect(false)} disabled={disconnecting} className="min-h-11 rounded-xl border border-[#ded6ca] bg-white px-4 text-xs font-semibold text-slate-700 disabled:opacity-50">Cancel</button>
                      <button type="button" onClick={() => void confirmDisconnect()} disabled={disconnecting} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-rose-600 px-4 text-xs font-semibold text-white disabled:opacity-60">
                        {disconnecting && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
                        {disconnecting ? "Disconnecting…" : "Disconnect account"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </AccessibleDialog>

      <AccessibleDialog
        open={airtableDialogOpen}
        onOpenChange={(open) => {
          if (airtableSubmitting) return;
          setAirtableDialogOpen(open);
          if (!open) {
            setAirtablePat("");
            setAirtableError(null);
          }
        }}
        title="Connect Airtable"
        description="Securely save an Airtable personal access token for your account."
        contentClassName="max-w-xl"
      >
        <form onSubmit={(event) => void submitAirtable(event)} className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-[#e4ddd2] px-6 pb-5 pt-6 pr-16">
            <div className="flex items-center gap-3">
              <ProviderIcon provider="airtable" />
              <div>
                <p className="text-xs font-semibold text-slate-500">API key connection</p>
                <h2 className="text-lg font-semibold text-slate-950">Connect Airtable</h2>
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
            <label htmlFor="airtable-personal-access-token" className="text-sm font-semibold text-slate-900">Personal access token</label>
            <p className="mt-1 text-xs leading-5 text-slate-500">Create a token in Airtable with record-write access only to the bases you want CrazyLoops to use.</p>
            <input
              id="airtable-personal-access-token"
              name="airtable-personal-access-token"
              type="password"
              value={airtablePat}
              onChange={(event) => setAirtablePat(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={512}
              required
              disabled={airtableSubmitting}
              aria-describedby="airtable-token-guidance"
              className="mt-3 min-h-12 w-full rounded-xl border border-[#d9d1c5] bg-white px-4 text-sm text-slate-900 outline-none transition focus:border-[#c49a25] focus:ring-2 focus:ring-[#f1c94b]/25 disabled:opacity-60"
              placeholder="pat…"
            />
            <div id="airtable-token-guidance" className="mt-4 rounded-xl border border-[#e4ddd2] bg-[#f8f4ec] p-4">
              <p className="flex items-center gap-2 text-xs font-semibold text-slate-900"><ShieldCheck className="size-4 text-[#8a6200]" />Stored securely</p>
              <p className="mt-2 text-xs leading-5 text-slate-600">The token is encrypted in the CrazyLoops credential vault. It is not sent to Airtable during setup, so this connection is locally configured until its first action runs.</p>
            </div>
            {airtableError && <p role="alert" className="mt-4 text-xs font-medium text-rose-700">{airtableError}</p>}
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-[#e4ddd2] px-6 py-4">
            <button type="button" onClick={() => setAirtableDialogOpen(false)} disabled={airtableSubmitting} className="min-h-11 rounded-xl px-4 text-xs font-semibold text-slate-600 hover:bg-[#f8f4ec] disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={airtableSubmitting || !airtablePat} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#d7aa2f] bg-[#fff7dc] px-4 text-xs font-semibold text-[#6f5100] hover:bg-[#fff2bd] disabled:opacity-50">
              {airtableSubmitting && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
              {airtableSubmitting ? "Saving…" : "Save connection"}
            </button>
          </div>
        </form>
      </AccessibleDialog>
    </>
  );
}
