/**
 * Interactive ChatGPT (Codex) device-code login.
 *
 * Flow (same endpoints the Codex CLI uses):
 *   1. POST /api/accounts/deviceauth/usercode  -> device_auth_id + user_code
 *   2. User opens https://auth.openai.com/codex/device and enters the code
 *   3. Poll /api/accounts/deviceauth/token    -> authorization_code + verifier
 *   4. Exchange at /oauth/token               -> access + refresh tokens
 */

import { execFile } from "node:child_process";
import type { ChatGPTTokens } from "./state.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE = "https://auth.openai.com";
const USER_CODE_URL = `${AUTH_BASE}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE}/api/accounts/deviceauth/token`;
export const DEVICE_VERIFICATION_URI = `${AUTH_BASE}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`;
const TOKEN_URL = `${AUTH_BASE}/oauth/token`;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export interface DeviceLoginInfo {
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
}

interface DeviceAuth {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
}

export function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    execFile(opener, [url], () => {});
  } catch {
    // best effort — the verification URL is displayed to the user anyway
  }
}

async function startDeviceAuth(signal?: AbortSignal): Promise<DeviceAuth> {
  const response = await fetch(USER_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ChatGPT 기기 로그인을 시작할 수 없습니다 (${response.status}): ${body || response.statusText}`);
  }
  const json = (await response.json()) as {
    device_auth_id?: string;
    user_code?: string;
    interval?: number | string;
  };
  const interval = typeof json.interval === "string" ? Number(json.interval.trim()) : json.interval;
  if (!json.device_auth_id || !json.user_code || !Number.isFinite(interval)) {
    throw new Error(`기기 로그인 응답이 올바르지 않습니다: ${JSON.stringify(json)}`);
  }
  return { deviceAuthId: json.device_auth_id, userCode: json.user_code, intervalSeconds: interval || 5 };
}

async function pollForCode(device: DeviceAuth, signal?: AbortSignal): Promise<{ code: string; verifier: string }> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let intervalMs = device.intervalSeconds * 1000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("로그인이 취소되었습니다");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const response = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
      signal,
    });
    if (response.ok) {
      const json = (await response.json()) as { authorization_code?: string; code_verifier?: string };
      if (json.authorization_code && json.code_verifier) {
        return { code: json.authorization_code, verifier: json.code_verifier };
      }
      throw new Error(`기기 로그인 응답이 올바르지 않습니다: ${JSON.stringify(json)}`);
    }
    if (response.status === 403 || response.status === 404) continue; // pending
    const body = await response.text().catch(() => "");
    let errorCode: string | undefined;
    try {
      const parsed = JSON.parse(body) as { error?: { code?: string } | string };
      errorCode = typeof parsed.error === "object" ? parsed.error?.code : parsed.error;
    } catch {
      // non-JSON error body
    }
    if (errorCode === "deviceauth_authorization_pending") continue;
    if (errorCode === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    throw new Error(`기기 로그인 실패 (${response.status}): ${body || response.statusText}`);
  }
  throw new Error("로그인 시간이 초과되었습니다 (15분) — 다시 시도하세요");
}

async function exchangeCode(code: string, verifier: string, signal?: AbortSignal): Promise<ChatGPTTokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: DEVICE_REDIRECT_URI,
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`토큰 교환 실패 (${response.status}): ${body || response.statusText}`);
  }
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.refresh_token) {
    throw new Error("토큰 교환 응답에 access_token/refresh_token 이 없습니다");
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

/** Run the full device-code login. `onCode` fires once with what to show the user. */
export async function deviceLogin(
  onCode: (info: DeviceLoginInfo) => void,
  signal?: AbortSignal,
): Promise<ChatGPTTokens> {
  const device = await startDeviceAuth(signal);
  onCode({ userCode: device.userCode, verificationUri: DEVICE_VERIFICATION_URI, intervalSeconds: device.intervalSeconds });
  const { code, verifier } = await pollForCode(device, signal);
  return exchangeCode(code, verifier, signal);
}
