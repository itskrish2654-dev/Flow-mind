"use client";

import { useEffect, useState } from "react";
import { Check, FileSpreadsheet, LoaderCircle } from "lucide-react";

import {
  getGooglePickerConfiguration,
  getSelectedGoogleSpreadsheetOptions,
  selectGoogleSpreadsheetForWorkflow,
} from "@/app/actions/connections";

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SPREADSHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";

type PickerDocument = { id?: string; name?: string; mimeType?: string };
type PickerData = { action?: string; docs?: PickerDocument[] };
type PickerView = { setMimeTypes: (mimeTypes: string) => PickerView };
type PickerInstance = { setVisible: (visible: boolean) => void };
type PickerBuilder = {
  setDeveloperKey: (key: string) => PickerBuilder;
  setAppId: (appId: string) => PickerBuilder;
  setOAuthToken: (token: string) => PickerBuilder;
  setOrigin: (origin: string) => PickerBuilder;
  addView: (view: PickerView) => PickerBuilder;
  setCallback: (callback: (data: PickerData) => void) => PickerBuilder;
  build: () => PickerInstance;
};
type GoogleWindow = Window & {
  gapi?: { load: (name: string, options: { callback: () => void; onerror: () => void }) => void };
  google?: {
    accounts: {
      oauth2: {
        initTokenClient: (config: {
          client_id: string;
          scope: string;
          include_granted_scopes: boolean;
          hint?: string;
          callback: (response: { access_token?: string; error?: string }) => void;
        }) => { requestAccessToken: (options: { prompt: string }) => void };
      };
    };
    picker: {
      Action: { PICKED: string; CANCEL: string };
      ViewId: { SPREADSHEETS: string };
      DocsView: new (viewId: string) => PickerView;
      PickerBuilder: new () => PickerBuilder;
    };
  };
};

const scriptLoads = new Map<string, Promise<void>>();

function loadScript(id: string, src: string) {
  const existing = scriptLoads.get(id);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const present = document.getElementById(id) as HTMLScriptElement | null;
    if (present?.dataset.loaded === "true") {
      resolve();
      return;
    }
    const script = present ?? document.createElement("script");
    script.id = id;
    script.src = src;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("Google Picker could not be loaded.")), { once: true });
    if (!present) document.head.appendChild(script);
  });
  scriptLoads.set(id, promise);
  return promise;
}

function loadPickerLibrary() {
  const googleWindow = window as GoogleWindow;
  return new Promise<void>((resolve, reject) => {
    if (!googleWindow.gapi) {
      reject(new Error("Google Picker could not be loaded."));
      return;
    }
    googleWindow.gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("Google Picker could not be loaded.")) });
  });
}

export function GoogleSpreadsheetPicker({
  workflowId,
  stepId,
  connectionId,
  value,
  onSelected,
}: {
  workflowId: string;
  stepId: string;
  connectionId?: string;
  value: string;
  onSelected: (spreadsheet: { id: string; title: string; worksheets: Array<{ id: number; title: string }> }) => void;
}) {
  const [spreadsheets, setSpreadsheets] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!connectionId) return;
    let active = true;
    void getSelectedGoogleSpreadsheetOptions(connectionId).then((result) => {
      if (!active) return;
      if (result.ok) setSpreadsheets(result.spreadsheets);
      else setMessage(result.error);
    });
    return () => { active = false; };
  }, [connectionId]);

  async function saveSelection(spreadsheetId: string, pickerAccessToken?: string) {
    if (!connectionId) return;
    const result = await selectGoogleSpreadsheetForWorkflow(
      workflowId,
      stepId,
      connectionId,
      spreadsheetId,
      pickerAccessToken,
    );
    if (!result.ok) throw new Error(result.error);
    setSpreadsheets((current) => [
      { id: result.spreadsheet.spreadsheetId, name: result.spreadsheet.title },
      ...current.filter((item) => item.id !== result.spreadsheet.spreadsheetId),
    ]);
    onSelected({
      id: result.spreadsheet.spreadsheetId,
      title: result.spreadsheet.title,
      worksheets: result.spreadsheet.worksheets,
    });
  }

  async function chooseSaved(spreadsheetId: string) {
    if (!spreadsheetId || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await saveSelection(spreadsheetId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Spreadsheet selection could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function openPicker() {
    if (!connectionId || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const configuration = await getGooglePickerConfiguration(connectionId);
      if (!configuration.ok) throw new Error(configuration.error);
      await Promise.all([
        loadScript("google-api-client", "https://apis.google.com/js/api.js"),
        loadScript("google-identity-services", "https://accounts.google.com/gsi/client"),
      ]);
      await loadPickerLibrary();
      const googleWindow = window as GoogleWindow;
      if (!googleWindow.google) throw new Error("Google Picker could not be loaded.");
      const tokenClient = googleWindow.google.accounts.oauth2.initTokenClient({
        client_id: configuration.config.clientId,
        scope: DRIVE_FILE_SCOPE,
        include_granted_scopes: false,
        ...(configuration.config.accountHint ? { hint: configuration.config.accountHint } : {}),
        callback: (response) => {
          if (!response.access_token || response.error) {
            setBusy(false);
            setMessage("Google did not authorize spreadsheet selection.");
            return;
          }
          const pickerView = new googleWindow.google!.picker.DocsView(googleWindow.google!.picker.ViewId.SPREADSHEETS);
          pickerView.setMimeTypes(SPREADSHEET_MIME_TYPE);
          const picker = new googleWindow.google!.picker.PickerBuilder()
            .setDeveloperKey(configuration.config.apiKey)
            .setAppId(configuration.config.appId)
            .setOAuthToken(response.access_token)
            .setOrigin(window.location.origin)
            .addView(pickerView)
            .setCallback((data) => {
              if (data.action === googleWindow.google!.picker.Action.CANCEL) {
                setBusy(false);
                return;
              }
              if (data.action !== googleWindow.google!.picker.Action.PICKED) return;
              const selected = data.docs?.[0];
              if (!selected?.id || selected.mimeType !== SPREADSHEET_MIME_TYPE) {
                setBusy(false);
                setMessage("Choose a Google spreadsheet.");
                return;
              }
              void saveSelection(selected.id, response.access_token).catch((error) => {
                setMessage(error instanceof Error ? error.message : "Spreadsheet selection could not be saved.");
              }).finally(() => setBusy(false));
            })
            .build();
          picker.setVisible(true);
        },
      });
      tokenClient.requestAccessToken({ prompt: "consent" });
    } catch (error) {
      setBusy(false);
      setMessage(error instanceof Error ? error.message : "Google Picker could not be opened.");
    }
  }

  const selected = spreadsheets.find((item) => item.id === value);
  return (
    <div className="space-y-2">
      {spreadsheets.length > 0 && (
        <select
          aria-label="Picker-selected Google spreadsheet"
          value={selected?.id ?? ""}
          disabled={busy || !connectionId}
          onChange={(event) => void chooseSaved(event.target.value)}
          className="h-10 w-full rounded-lg border border-[#ded6ca] bg-[#f8f4ec] px-3 text-[10px] text-slate-800 outline-none focus:border-[#d7aa2f] focus:bg-white"
        >
          <option value="">Choose a selected spreadsheet</option>
          {spreadsheets.map((spreadsheet) => <option key={spreadsheet.id} value={spreadsheet.id}>{spreadsheet.name}</option>)}
        </select>
      )}
      {value && !selected && (
        <p role="alert" className="text-[9px] leading-4 text-amber-700">This saved value was not selected through Google Picker. Choose a spreadsheet again.</p>
      )}
      <button
        type="button"
        disabled={busy || !connectionId}
        onClick={() => void openPicker()}
        className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-[#d7aa2f] bg-white px-3 text-[10px] font-semibold text-[#6f5100] hover:bg-[#fff8e3] disabled:opacity-50"
      >
        {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : selected ? <Check className="size-3.5" /> : <FileSpreadsheet className="size-3.5" />}
        {busy ? "Opening Google…" : selected ? "Choose a different spreadsheet" : "Choose with Google Picker"}
      </button>
      {!connectionId && <p className="text-[9px] leading-4 text-slate-500">Choose a connected Google account first.</p>}
      {message && <p role="alert" className="text-[9px] leading-4 text-rose-700">{message}</p>}
    </div>
  );
}
