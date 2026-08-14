"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";

import { reportTurnstileClientError } from "@/app/actions/turnstile";
import type { TurnstileBrowserCategory } from "@/lib/turnstile-diagnostics";

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      theme: "light";
      appearance: "interaction-only";
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": (errorCode: string) => void;
      "timeout-callback": () => void;
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
  const correlationIdRef = useRef<string | null>(null);
  const [scriptReady, setScriptReady] = useState(false);

  function browserCategory(): TurnstileBrowserCategory {
    const agent = window.navigator.userAgent;
    if (/Edg\//.test(agent)) return "edge";
    if (/Firefox\//.test(agent)) return "firefox";
    if (/Safari\//.test(agent) && !/Chrome\//.test(agent)) return "safari";
    if (/Chrome\//.test(agent)) return "chrome";
    return "other";
  }

  const reportFailure = useCallback((errorCode: string) => {
    if (!correlationIdRef.current) correlationIdRef.current = crypto.randomUUID();
    void reportTurnstileClientError({
      errorCode,
      hostname: window.location.hostname,
      page: window.location.pathname,
      browserCategory: browserCategory(),
      correlationId: correlationIdRef.current,
    });
  }, []);

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
      "error-callback": (errorCode) => {
        callbacksRef.current.onToken(null);
        reportFailure(errorCode || "unknown_error");
        callbacksRef.current.onError("The security challenge could not load. Please retry.");
      },
      "timeout-callback": () => {
        callbacksRef.current.onToken(null);
        reportFailure("challenge_timeout");
        callbacksRef.current.onError("The security challenge timed out. Please retry.");
      },
    });
  }, [reportFailure, siteKey]);

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
    <div className="turnstile-safe rounded-xl border border-[#ddd5c9] bg-[#faf8f4] px-2 py-2.5 sm:px-3">
      <Script
        id="flowmind-auth-turnstile"
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onReady={() => setScriptReady(true)}
        onError={() => {
          reportFailure("script_load_failure");
          onError("The security challenge could not load. Please retry.");
        }}
      />
      <div ref={containerRef} role="group" className="min-h-[65px] max-w-full" aria-label="Security challenge" />
      <p className="mt-1 text-center text-[10px] text-slate-500">{helperText}</p>
    </div>
  );
}
