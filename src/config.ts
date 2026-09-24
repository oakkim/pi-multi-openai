/**
 * Configuration for pi-openai-pool.
 *
 * Config lives in `~/.pi/agent/openai-pool.json` (override with OPENAI_POOL_CONFIG).
 * The order of `accounts` IS the priority order: the first usable account serves
 * every request; when it runs out the next one takes over automatically.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AccountKind = "apiKey" | "chatgpt";
export type Family = "apiKey" | "chatgpt";
export type Strategy = "priority" | "rotate";

export interface AccountConfig {
  /** Unique display name. */
  name: string;
  /** "apiKey" for OpenAI API keys / compatible endpoints, "chatgpt" for ChatGPT plan accounts. */
  kind: AccountKind;
  /** kind=apiKey: key literal, $ENV / ${ENV} interpolation, or `!command`. */
  apiKey?: string;
  /** Optional endpoint override (default: https://api.openai.com/v1 or https://chatgpt.com/backend-api). */
  baseUrl?: string;
  /** Extra headers merged into every request made with this account. */
  headers?: Record<string, string>;
  /** Optional model-id include patterns (glob with `*`). Omitted = all models. */
  models?: string[];

  // kind=chatgpt credential sources (pick one):
  /** Path to a Codex CLI style auth.json (e.g. ~/.codex/auth.json). */
  authFile?: string;
  /** Inline tokens (persisted refreshes are stored in the state file). */
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms (or seconds) when accessToken expires. */
  expiresAt?: number;
}

export interface CustomModelConfig {
  id: string;
  name: string;
  /** "openai-codex-responses" models are served by chatgpt accounts, others by apiKey accounts. */
  api: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  baseUrl?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
}

export interface PolicyConfig {
  /** Cooldown after 429 / rate-limit style failures. */
  rateLimitCooldownMs: number;
  /** Cooldown after usage-limit / quota failures when no explicit reset time is known. */
  usageLimitCooldownMs: number;
  /** Cooldown after transient network / 5xx failures. */
  transientCooldownMs: number;
  /** Client-side retries per attempt (keep low so failover stays fast). */
  attemptRetries: number;
}

export interface PoolConfig {
  accounts: AccountConfig[];
  /** "priority": always the highest-priority usable account. "rotate": spread load round-robin. */
  strategy: Strategy;
  models: {
    include?: string[];
    exclude?: string[];
    custom?: CustomModelConfig[];
  };
  policy: PolicyConfig;
}

export interface ConfigLoadResult {
  config?: PoolConfig;
  configPath: string;
  exists: boolean;
  error?: string;
}

export const DEFAULT_BASE_URL: Record<Family, string> = {
  apiKey: "https://api.openai.com/v1",
  chatgpt: "https://chatgpt.com/backend-api",
};

export function getAgentDir(): string {
  return process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function getConfigPath(): string {
  return process.env.OPENAI_POOL_CONFIG || path.join(getAgentDir(), "openai-pool.json");
}

export function getStatePath(): string {
  return process.env.OPENAI_POOL_STATE || path.join(getAgentDir(), "openai-pool.state.json");
}

export function sampleConfig(): string {
  const sample = {
    accounts: [
      {
        name: "chatgpt-main",
        kind: "chatgpt",
        authFile: "~/.codex/auth.json",
      },
      {
        name: "chatgpt-backup",
        kind: "chatgpt",
        refreshToken: "여기에 refresh token 붙여넣기",
      },
      {
        name: "api-key-1",
        kind: "apiKey",
        apiKey: "$OPENAI_API_KEY",
      },
    ],
    strategy: "priority",
    models: { include: ["*"], exclude: [] },
    policy: {
      rateLimitCooldownMs: 60000,
      usageLimitCooldownMs: 18000000,
      transientCooldownMs: 30000,
      attemptRetries: 0,
    },
  };
  return JSON.stringify(sample, null, 2) + "\n";
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function bad(msg: string): never {
  throw new Error(msg);
}

function normalizeAccount(raw: unknown, index: number, seen: Set<string>): AccountConfig {
  const a = raw as Record<string, unknown>;
  if (!a || typeof a !== "object") bad(`accounts[${index}]: 객체가 아닙니다`);
  const name = typeof a.name === "string" ? a.name.trim() : "";
  if (!name) bad(`accounts[${index}].name 이 필요합니다`);
  if (seen.has(name)) bad(`accounts[${index}].name "${name}" 이(가) 중복됩니다`);
  seen.add(name);
  const kind = a.kind === "chatgpt" ? "chatgpt" : a.kind === "apiKey" ? "apiKey" : undefined;
  if (!kind) bad(`accounts[${index}].kind 은 "apiKey" 또는 "chatgpt" 여야 합니다`);

  const account: AccountConfig = { name, kind };
  if (typeof a.apiKey === "string") account.apiKey = a.apiKey;
  if (typeof a.baseUrl === "string") account.baseUrl = expandHome(a.baseUrl.replace(/\/+$/, ""));
  if (a.headers && typeof a.headers === "object") account.headers = a.headers as Record<string, string>;
  if (Array.isArray(a.models)) account.models = a.models.filter((m): m is string => typeof m === "string");
  if (typeof a.authFile === "string") account.authFile = expandHome(a.authFile);
  if (typeof a.accessToken === "string") account.accessToken = a.accessToken;
  if (typeof a.refreshToken === "string") account.refreshToken = a.refreshToken;
  if (typeof a.expiresAt === "number") account.expiresAt = a.expiresAt;

  if (kind === "apiKey" && !account.apiKey) bad(`accounts[${index}](${name}): apiKey 가 필요합니다`);
  if (kind === "chatgpt" && !account.authFile && !account.refreshToken && !account.accessToken) {
    bad(`accounts[${index}](${name}): authFile 또는 refreshToken/accessToken 이 필요합니다`);
  }
  return account;
}

export function parseConfig(text: string): PoolConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    bad(`JSON 파싱 실패: ${(e as Error).message}`);
  }
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== "object") bad("설정은 JSON 객체여야 합니다");
  if (!Array.isArray(r.accounts)) bad("accounts 배열이 필요합니다");

  const seen = new Set<string>();
  const accounts = r.accounts.map((a, i) => normalizeAccount(a, i, seen));

  const strategy: Strategy = r.strategy === "rotate" ? "rotate" : "priority";

  const modelsRaw = (r.models ?? {}) as Record<string, unknown>;
  const models: PoolConfig["models"] = {};
  if (Array.isArray(modelsRaw.include)) models.include = modelsRaw.include.filter((m): m is string => typeof m === "string");
  if (Array.isArray(modelsRaw.exclude)) models.exclude = modelsRaw.exclude.filter((m): m is string => typeof m === "string");
  if (Array.isArray(modelsRaw.custom)) models.custom = modelsRaw.custom as CustomModelConfig[];

  const policyRaw = (r.policy ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  const policy: PolicyConfig = {
    rateLimitCooldownMs: num(policyRaw.rateLimitCooldownMs, 60_000),
    usageLimitCooldownMs: num(policyRaw.usageLimitCooldownMs, 5 * 60 * 60 * 1000),
    transientCooldownMs: num(policyRaw.transientCooldownMs, 30_000),
    attemptRetries: num(policyRaw.attemptRetries, 0),
  };

  return { accounts, strategy, models, policy };
}

export function loadConfig(): ConfigLoadResult {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return { configPath, exists: false };
  }
  try {
    const config = parseConfig(fs.readFileSync(configPath, "utf8"));
    return { config, configPath, exists: true };
  } catch (e) {
    return { configPath, exists: true, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Value resolution: `!command`, `$ENV` / `${ENV}`, `$$` literal.
// ---------------------------------------------------------------------------

export function resolveValue(value: string): string {
  if (value.startsWith("!")) {
    return execSync(value.slice(1), { encoding: "utf8" }).trim();
  }
  return value
    .replace(/\$\$\u0000/g, "\u0000")
    .replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, plain) => process.env[braced ?? plain] ?? "")
    .replace(/\u0000/g, "$")
    .replace(/\$\$/g, "$");
}

// ---------------------------------------------------------------------------
// Minimal glob matching (`*` wildcard) for model filters.
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchGlob(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return re.test(value);
}

export function matchesPatterns(patterns: string[] | undefined, value: string): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => matchGlob(p, value));
}
