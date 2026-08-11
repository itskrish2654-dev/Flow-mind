"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      theme: "light";
      appearance: "interaction-only";
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
      "response-field": boolean;
      "response-field-name": string;
    },
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function AuthTurnstile({
  siteKey,
  resetSignal,
  onToken,
  onError,
  helperText = "Bot protection is verified directly by Supabase Auth.",
}: {
  siteKey: string;
  resetSignal: number;
  onToken: (token: string | null) => void;
  onError: (message: string | null) => void;
  helperText?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const callbacksRef = useRef({ onToken, onError });
  const [scriptReady, setScriptReady] = useState(false);

  useEffect(() => {
    callbacksRef.current = { onToken, onError };
  }, [onError, onToken]);

  const renderWidget = useCallback(() => {
    if (!containerRef.current || !window.turnstile || widgetIdRef.current) return;
    widgetIdRef.current = window.turnstile.render(containerRef.current, {
      sitekey: siteKey,
      theme: "light",
      appearance: "interaction-only",
      "response-field": true,
      "response-field-name": "cf-turnstile-response",
      callback: (token) => {
        callbacksRef.current.onError(null);
        callbacksRef.current.onToken(token);
      },
      "expired-callback": () => {
        callbacksRef.current.onToken(null);
        callbacksRef.current.onError("The security challenge expired. Please complete it again.");
      },
      "error-callback": () => {
        callbacksRef.current.onToken(null);
        callbacksRef.current.onError("The security challenge could not load. Please retry.");
      },
    });
  }, [siteKey]);

  useEffect(() => {
    if (!scriptReady) return;
    renderWidget();
    return () => {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [renderWidget, scriptReady]);

  useEffect(() => {
    if (widgetIdRef.current && window.turnstile) {
      callbacksRef.current.onToken(null);
      window.turnstile.reset(widgetIdRef.current);
    }
  }, [resetSignal]);

  return (
    <div className="rounded-xl border border-[#ddd5c9] bg-[#faf8f4] px-3 py-2.5">
      <Script
        id="flowmind-auth-turnstile"
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onReady={() => setScriptReady(true)}
        onError={() => onError("The security challenge could not load. Please retry.")}
      />
      <div ref={containerRef} className="min-h-[65px]" aria-label="Security challenge" />
      <p className="mt-1 text-center text-[10px] text-slate-500">{helperText}</p>
    </div>
  );
}
