import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  getSupabaseAuthCaptchaOptions,
  isAuthCaptchaRequired,
  isAuthCaptchaTokenAccepted,
} from "../lib/security/auth-captcha";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const authAction = source("app/actions/auth.ts");
const loginForm = source("components/login-form.tsx");
const loginPage = source("app/login/page.tsx");
const accountAction = source("app/actions/account.ts");
const envExample = source(".env.example");

test("auth CAPTCHA mode is fail-closed for absent, invalid, and mistyped values", () => {
  const previous = process.env.FLOWMIND_AUTH_CAPTCHA_MODE;
  try {
    delete process.env.FLOWMIND_AUTH_CAPTCHA_MODE;
    assert.equal(isAuthCaptchaRequired(), true);
    process.env.FLOWMIND_AUTH_CAPTCHA_MODE = "disabled";
    assert.equal(isAuthCaptchaRequired(), false);
    for (const value of ["", "disable", "DISABLED", "false", " disabled "]) {
      process.env.FLOWMIND_AUTH_CAPTCHA_MODE = value;
      assert.equal(isAuthCaptchaRequired(), true, value);
    }
  } finally {
    if (previous === undefined) delete process.env.FLOWMIND_AUTH_CAPTCHA_MODE;
    else process.env.FLOWMIND_AUTH_CAPTCHA_MODE = previous;
  }
});

test("server CAPTCHA validation accepts omission only in explicitly disabled mode", () => {
  assert.equal(isAuthCaptchaTokenAccepted(false, undefined), true);
  assert.equal(isAuthCaptchaTokenAccepted(true, undefined), false);
  assert.equal(isAuthCaptchaTokenAccepted(true, ""), false);
  assert.equal(isAuthCaptchaTokenAccepted(true, "valid-token"), true);
});

test("Supabase auth options omit CAPTCHA when disabled and include it when required", () => {
  assert.deepEqual(getSupabaseAuthCaptchaOptions(false, undefined), {});
  assert.deepEqual(getSupabaseAuthCaptchaOptions(false, "ignored-test-token"), {});
  assert.deepEqual(getSupabaseAuthCaptchaOptions(true, "verified-token"), {
    captchaToken: "verified-token",
  });
  assert.throws(() => getSupabaseAuthCaptchaOptions(true, undefined));
});

test("login UI allows tokenless submit only when the server passes captchaRequired=false", () => {
  assert.match(loginPage, /const captchaRequired = isAuthCaptchaRequired\(\)/);
  assert.match(loginPage, /captchaRequired=\{captchaRequired\}/);
  assert.match(loginForm, /if \(captchaRequired && !captchaToken\)/);
  assert.match(loginForm, /disabled=\{captchaRequired && \(!turnstileSiteKey \|\| !captchaToken\)\}/);
  assert.match(loginForm, /\{captchaRequired && turnstileSiteKey \? \(/);
  assert.match(loginForm, /\.\.\.\(captchaRequired && captchaToken \? \{ captchaToken \} : \{\}\)/);
});

test("server auth keeps rate limits in both modes and conditionally forwards CAPTCHA", () => {
  const captchaMode = authAction.indexOf("const captchaRequired = isAuthCaptchaRequired()");
  const ipLimit = authAction.indexOf('await enforceRateLimit(`${parsed.data.mode}-ip`');
  const emailLimit = authAction.indexOf('await enforceRateLimit(`${parsed.data.mode}-email`');
  const authClient = authAction.indexOf("const supabase = await createClient()");
  assert.ok(captchaMode >= 0 && ipLimit > captchaMode && emailLimit > ipLimit && authClient > emailLimit);
  assert.match(authAction, /captchaToken: CaptchaTokenSchema\.optional\(\)/);
  assert.match(authAction, /getSupabaseAuthCaptchaOptions\([\s\S]*captchaRequired/);
  assert.match(authAction, /\.\.\.\(captchaRequired \? \{ options: captchaOptions \} : \{\}\)/);
  assert.match(authAction, /resetPasswordForEmail\([\s\S]*\.\.\.captchaOptions/);
  assert.match(authAction, /signUp\([\s\S]*\.\.\.captchaOptions/);
});

test("production remains fail-closed and destructive account deletion remains unchanged", () => {
  assert.match(envExample, /FLOWMIND_AUTH_CAPTCHA_MODE=/);
  assert.match(envExample, /Leave empty\/default in production/);
  assert.match(accountAction, /captchaToken: z\.string\(\)\.min\(1\)\.max\(4_096\)/);
  assert.match(accountAction, /options: \{ captchaToken: parsed\.data\.captchaToken \}/);
  assert.doesNotMatch(accountAction, /isAuthCaptchaRequired|FLOWMIND_AUTH_CAPTCHA_MODE/);
});
