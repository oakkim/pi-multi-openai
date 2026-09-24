/**
 * ChatGPT (Codex) OAuth token management for `kind: "chatgpt"` accounts.
 *
 * Tokens come either from a Codex CLI auth.json (which Codex itself refreshes)
 * or from inline config credentials (we refresh them ourselves and persist the
 * rotated refresh token in the pool state file).
 */

import fs from "node:fs";
import path from "node:path";
import type { AccountConfig } from "./config.ts";
import type { AccountState, ChatGPTTokens } from "./state.ts";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Public OAuth client id used by the Codex CLI (also used by pi's ChatGPT login). */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** Refresh this long before expiry. */
const EXPIRY_MARGIN_MS = 120_000;

function normalizeExpiry(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n; // accept seconds or ms
}

interface TokenEntry {
  entry: Record<string, unknown>;
  /** true = Codex style (access_token/refresh_token/expires_at), false = pi style (access/refresh/expires). */
  snake: boolean;
}

/**
 * Locate the token object inside an auth file. Supports:
 * - Codex CLI auth.json: { tokens: { access_token, refresh_token, expires_at } }
 * - pi auth.json:       { "openai-codex": { access, refresh, expires } }
 * - flat files:         top-level access_token/... or access/...
 */
function findTokenEntry(raw: Record<string, any>): TokenEntry {
  if (raw.tokens && typeof raw.tokens === "object") {
    return { entry: raw.tokens as Record<string, unknown>, snake: true };
  }
  if (raw["openai-codex"] && typeof raw["openai-codex"] === "object") {
    return { entry: raw["openai-codex"] as Record<string, unknown>, snake: false };
  }
  const snake = !("access" in raw || "refresh" in raw || "expires" in raw);
  return { entry: raw, snake };
}

export function readTokensFromAuthFile(file: string): ChatGPTTokens | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
    const { entry, snake } = findTokenEntry(raw);
    const access = (snake ? entry.access_token ?? entry.accessToken : entry.access) as string | undefined;
    const refresh = (snake ? entry.refresh_token ?? entry.refreshToken : entry.refresh) as string | undefined;
    if (!access && !refresh) return undefined;
    let expiresAt = normalizeExpiry(snake ? entry.expires_at ?? entry.expiresAt : entry.expires);
    if (!expiresAt && typeof entry.expires_in === "number") {
      expiresAt = Date.now() + entry.expires_in * 1000;
    }
    return { access: access ?? "", refresh: refresh ?? "", expiresAt };
  } catch {
    return undefined;
  }
}

export function writeTokensToAuthFile(file: string, tokens: ChatGPTTokens): void {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
    const { entry, snake } = findTokenEntry(raw);
    if (snake) {
      const prev = entry.expires_at;
      const wasSeconds = typeof prev === "number" && prev < 1e12;
      entry.access_token = tokens.access;
      entry.refresh_token = tokens.refresh;
      entry.expires_at = wasSeconds ? Math.floor(tokens.expiresAt / 1000) : tokens.expiresAt;
    } else {
      entry.access = tokens.access;
      entry.refresh = tokens.refresh;
      entry.expires = tokens.expiresAt;
    }
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
  } catch {
    // best effort: refreshed tokens still live in the pool state file
  }
}

/** Write tokens to a pool-managed store file (Codex auth.json shape). */
export function writeTokenStoreFile(file: string, tokens: ChatGPTTokens): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        tokens: {
          access_token: tokens.access,
          refresh_token: tokens.refresh,
          expires_at: Math.floor(tokens.expiresAt / 1000),
        },
        last_refresh: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
}

/**
 * Extract the ChatGPT account id embedded in an access token JWT
 * (the same way pi-ai's Codex API builds its `chatgpt-account-id` header).
 */
export function extractAccountId(access: string): string | undefined {
  try {
    const part = access.split(".")[1];
    const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64url").toString()) as Record<string, any>;
    const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

export async function refreshTokens(refreshToken: string, signal?: AbortSignal): Promise<ChatGPTTokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ChatGPT 토큰 갱신 실패 (${response.status}): ${body || response.statusText}`);
  }
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("ChatGPT 토큰 갱신 응답에 access_token 이 없습니다");
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token ?? refreshToken,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - EXPIRY_MARGIN_MS,
  };
}

/**
 * Resolve a valid access token for an account, refreshing near-expired tokens.
 * Refreshed tokens are persisted (authFile write-back and/or pool state).
 */
export async function resolveChatGPTTokens(
  account: AccountConfig,
  entry: AccountState,
  persist: () => void,
  signal?: AbortSignal,
): Promise<ChatGPTTokens> {
  let tokens: ChatGPTTokens | undefined;
  if (account.authFile) {
    tokens = readTokensFromAuthFile(account.authFile);
    // authFile tokens are authoritative; state tokens are the fallback.
    if (!tokens?.access && !tokens?.refresh) tokens = entry.tokens;
  } else {
    tokens = entry.tokens ?? {
      access: account.accessToken ?? "",
      refresh: account.refreshToken ?? "",
      expiresAt: account.expiresAt ?? 0,
    };
  }
  if (!tokens || (!tokens.access && !tokens.refresh)) {
    throw new Error(`${account.name}: 사용할 수 있는 ChatGPT 토큰이 없습니다`);
  }

  const expired = tokens.expiresAt > 0 && tokens.expiresAt - Date.now() < EXPIRY_MARGIN_MS;
  if ((!tokens.access || expired) && tokens.refresh) {
    const refreshed = await refreshTokens(tokens.refresh, signal);
    entry.tokens = refreshed;
    if (account.authFile) writeTokensToAuthFile(account.authFile, refreshed);
    persist();
    return refreshed;
  }
  if (!tokens.access) {
    throw new Error(`${account.name}: access token 이 없고 refresh token 도 없습니다`);
  }
  return tokens;
}
