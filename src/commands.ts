/**
 * `/openai-pool` command: inspect and manage the account pool.
 *
 *   /openai-pool                 상태 보기
 *   /openai-pool init            설정 파일이 없으면 샘플 생성
 *   /openai-pool test [name]     계정별 인증/사용 가능 여부 실측
 *   /openai-pool reset [name|all] 쿨다운/소진/비활성 상태 초기화
 *   /openai-pool disable <name>  계정 비활성화
 *   /openai-pool enable <name>   계정 다시 활성화
 *   /openai-pool use [name|auto] 계정 고정 (인자 없으면 고정 해제)
 *   /openai-pool reload          설정 다시 읽기 (확장 전체 리로드)
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  getConfigPath,
  getTokenStoreDir,
  sampleConfig,
  tokenStorePathFor,
  updateConfigFile,
} from "./config.ts";
import { extractAccountId, writeTokenStoreFile } from "./chatgpt.ts";
import { deviceLogin, type DeviceLoginInfo, openBrowser } from "./chatgpt-login.ts";
import { type AccountPool, formatDuration, statusText } from "./pool.ts";
import type { ConfigLoadResult } from "./config.ts";
import type { ChatGPTTokens, StateStore } from "./state.ts";

export interface CommandDeps {
  pool?: AccountPool;
  store: StateStore;
  loaded: ConfigLoadResult;
}

const SUBCOMMANDS = ["status", "init", "add", "login", "remove", "test", "reset", "enable", "disable", "use", "reload"];

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand("openai-pool", {
    description: "OpenAI 계정 풀 상태 확인/관리 (우선순위 failover)",
    getArgumentCompletions: (prefix) => {
      const [first, second] = prefix.split(/\s+/);
      if (second !== undefined || prefix.endsWith(" ")) {
        const names = deps.pool?.runtimes.map((r) => r.name) ?? [];
        const partial = second ?? "";
        return names
          .filter((n) => n.startsWith(partial))
          .map((n) => ({ value: `${first} ${n}`, label: n }));
      }
      return SUBCOMMANDS.filter((s) => s.startsWith(first))
        .map((s) => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      switch (sub) {
        case "status":
          return showStatus(deps, ctx);
        case "init":
          return initConfig(deps, ctx);
        case "add":
          return addAccount(ctx);
        case "login":
          return reloginAccount(ctx, rest[0]);
        case "remove":
          return removeAccount(ctx, rest[0]);
        case "test":
          return testAccounts(deps, ctx, rest[0]);
        case "reset":
          return resetAccounts(deps, ctx, rest[0]);
        case "enable":
        case "disable":
          return toggleAccount(deps, ctx, sub, rest[0]);
        case "use":
          return pinAccount(deps, ctx, rest[0]);
        case "reload":
          await ctx.reload();
          return;
        default:
          ctx.ui.notify(`알 수 없는 하위 명령: ${sub} (status|add|login|remove|test|reset|enable|disable|use|reload)`, "warning");
      }
    },
  });
}

// ---------------------------------------------------------------------------

function showStatus(deps: CommandDeps, ctx: ExtensionCommandContext): void {
  const { pool, loaded } = deps;
  if (loaded.error) {
    ctx.ui.notify(`설정 오류: ${loaded.error}`, "error");
    return;
  }
  if (!pool) {
    ctx.ui.notify(`설정 파일이 없습니다: ${loaded.configPath} — /openai-pool init 으로 생성하세요`, "warning");
    return;
  }

  const now = Date.now();
  const state = pool.state();
  const lines: string[] = [];
  lines.push(
    `strategy: ${pool.config.strategy} · pinned: ${state.pinned ?? "없음"} · 마지막 사용: ${state.lastSelected ?? "-"}`,
  );
  lines.push("");
  pool.runtimes.forEach((r, i) => {
    const marker = r.name === state.lastSelected ? "▶" : r.name === state.pinned ? "*" : " ";
    const u = r.entry.usage;
    const when = r.entry.lastUsedAt ? new Date(r.entry.lastUsedAt).toLocaleString() : "-";
    lines.push(
      `${marker} ${String(i + 1).padStart(2)}. ${r.name} [${r.kind === "chatgpt" ? "chatgpt" : "api-key"}] ${statusText(r, now)}`,
    );
    lines.push(
      `      요청 ${u.requests} · in ${u.input.toLocaleString()} · out ${u.output.toLocaleString()} · $${u.cost.toFixed(4)} · 최근 ${when}`,
    );
    if (r.entry.lastError) lines.push(`      최근 오류: ${r.entry.lastError.slice(0, 120)}`);
  });
  void ctx.ui.select("openai-pool 상태", lines);
}

function initConfig(deps: CommandDeps, ctx: ExtensionCommandContext): void {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    ctx.ui.notify(`이미 존재합니다: ${configPath}`, "info");
    return;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, sampleConfig());
  ctx.ui.notify(`설정 생성: ${configPath} — 이제 /openai-pool add 로 계정을 추가하세요`, "info");
}

// ---------------------------------------------------------------------------
// Account onboarding: /openai-pool add | login | remove
// ---------------------------------------------------------------------------

interface RawAccount {
  name?: string;
  kind?: string;
  [key: string]: unknown;
}

function readRawConfig(): Record<string, any> {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return { accounts: [] };
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>;
  } catch {
    return { accounts: [] };
  }
}

/** Device-code login with the code displayed in a widget + browser opened. */
async function runDeviceLoginUI(ctx: ExtensionCommandContext): Promise<ChatGPTTokens> {
  const show = (info: DeviceLoginInfo) => {
    openBrowser(info.verificationUri);
    const lines = [
      `\u{1f510} ChatGPT 로그인 — 브라우저에서 다음 코드를 입력하세요:  ${info.userCode}`,
      `   ${info.verificationUri}   (브라우저가 열리지 않으면 직접 접속)`,
      "   승인하면 자동으로 완료됩니다 (최대 15분)",
    ];
    ctx.ui.setWidget("openai-pool-login", lines);
    if (!ctx.hasUI) console.log(lines.join("\n"));
  };
  try {
    return await deviceLogin(show);
  } finally {
    ctx.ui.setWidget("openai-pool-login", undefined);
  }
}

async function promptName(ctx: ExtensionCommandContext, suggestion: string, taken: Set<string>): Promise<string | undefined> {
  for (;;) {
    const typed = await ctx.ui.input("계정 이름 (빈칸 = 기본값)", suggestion);
    if (typed === undefined) return undefined; // cancelled
    const name = typed.trim() || suggestion;
    if (taken.has(name)) {
      ctx.ui.notify(`이미 존재하는 이름입니다: ${name}`, "warning");
      continue;
    }
    return name;
  }
}

async function addAccount(ctx: ExtensionCommandContext): Promise<void> {
  const method = await ctx.ui.select("계정 추가 방식", [
    "ChatGPT 계정 — 브라우저 로그인 (권장)",
    "ChatGPT 계정 — refresh token 붙여넣기",
    "OpenAI API 키",
  ]);
  if (!method) return;

  const raw = readRawConfig();
  const accounts: RawAccount[] = Array.isArray(raw.accounts) ? raw.accounts : [];
  const taken = new Set(accounts.map((a) => String(a.name ?? "")));

  let entry: Record<string, any> | undefined;
  let suggestion = "";
  let summary = "";

  if (method.includes("브라우저")) {
    ctx.ui.notify("ChatGPT 로그인을 시작합니다...", "info");
    let tokens: ChatGPTTokens;
    try {
      tokens = await runDeviceLoginUI(ctx);
    } catch (e) {
      ctx.ui.notify(`로그인 실패: ${(e as Error).message}`, "error");
      return;
    }
    const accountId = extractAccountId(tokens.access)?.slice(0, 8) ?? "new";
    suggestion = `chatgpt-${accountId}`;
    const name = await promptName(ctx, suggestion, taken);
    if (!name) return;
    const authFile = tokenStorePathFor(name);
    writeTokenStoreFile(authFile, tokens);
    entry = { name, kind: "chatgpt", authFile };
    summary = `${name} (ChatGPT, 브라우저 로그인)`;
  } else if (method.includes("refresh token")) {
    const refresh = await ctx.ui.input("ChatGPT refresh token 붙여넣기", "rt.1....");
    if (!refresh?.trim()) return;
    const access = await ctx.ui.input("access token (선택 — 비워두면 자동 갱신)", "");
    suggestion = `chatgpt-${taken.size + 1}`;
    const name = await promptName(ctx, suggestion, taken);
    if (!name) return;
    entry = { name, kind: "chatgpt", refreshToken: refresh.trim() };
    if (access?.trim()) entry.accessToken = access.trim();
    summary = `${name} (ChatGPT, 토큰 붙여넣기)`;
  } else {
    const key = await ctx.ui.input("OpenAI API 키", "sk-...");
    if (!key?.trim()) return;
    const baseUrl = await ctx.ui.input("엔드포인트 (빈칸 = 기본)", "https://api.openai.com/v1");
    suggestion = `api-${taken.size + 1}`;
    const name = await promptName(ctx, suggestion, taken);
    if (!name) return;
    entry = { name, kind: "apiKey", apiKey: key.trim() };
    if (baseUrl?.trim()) entry.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    summary = `${name} (API 키)`;
  }

  const position = await ctx.ui.select("우선순위 위치", ["맨 뒤에 추가 (예비 계정)", "맨 앞에 추가 (최우선 계정)"]);
  if (position?.startsWith("맨 앞")) accounts.unshift(entry);
  else accounts.push(entry);

  updateConfigFile((r) => {
    r.accounts = accounts;
  });
  ctx.ui.notify(`계정 추가 완료: ${summary} — 적용 중...`, "info");
  await ctx.reload();
}

async function reloginAccount(ctx: ExtensionCommandContext, name?: string): Promise<void> {
  const raw = readRawConfig();
  const accounts: RawAccount[] = Array.isArray(raw.accounts) ? raw.accounts : [];
  if (!name) {
    ctx.ui.notify(`사용법: /openai-pool login <계정이름> (보유: ${accounts.map((a) => a.name).join(", ") || "없음"})`, "warning");
    return;
  }
  const account = accounts.find((a) => a.name === name);
  if (!account) {
    ctx.ui.notify(`계정을 찾을 수 없습니다: ${name}`, "warning");
    return;
  }
  if (account.kind !== "chatgpt") {
    ctx.ui.notify("API 키 계정은 설정 파일에서 apiKey 를 수정하세요", "warning");
    return;
  }

  ctx.ui.notify(`ChatGPT 재로그인: ${name}`, "info");
  let tokens: ChatGPTTokens;
  try {
    tokens = await runDeviceLoginUI(ctx);
  } catch (e) {
    ctx.ui.notify(`로그인 실패: ${(e as Error).message}`, "error");
    return;
  }
  const authFile = tokenStorePathFor(name);
  writeTokenStoreFile(authFile, tokens);
  updateConfigFile((r) => {
    const target = (r.accounts as RawAccount[]).find((a) => a.name === name);
    if (target) {
      target.authFile = authFile;
      delete target.refreshToken;
      delete target.accessToken;
      delete target.expiresAt;
    }
  });
  ctx.ui.notify(`${name} 재로그인 완료 — 적용 중...`, "info");
  await ctx.reload();
}

async function removeAccount(ctx: ExtensionCommandContext, name?: string): Promise<void> {
  const raw = readRawConfig();
  const accounts: RawAccount[] = Array.isArray(raw.accounts) ? raw.accounts : [];
  if (!name) {
    ctx.ui.notify(`사용법: /openai-pool remove <계정이름> (보유: ${accounts.map((a) => a.name).join(", ") || "없음"})`, "warning");
    return;
  }
  const account = accounts.find((a) => a.name === name);
  if (!account) {
    ctx.ui.notify(`계정을 찾을 수 없습니다: ${name}`, "warning");
    return;
  }
  const ok = await ctx.ui.confirm("계정 제거", `"${name}" 계정을 풀에서 제거할까요?`);
  if (!ok) return;

  updateConfigFile((r) => {
    r.accounts = (r.accounts as RawAccount[]).filter((a) => a.name !== name);
  });
  const authFile = typeof account.authFile === "string" ? account.authFile : "";
  if (authFile.startsWith(getTokenStoreDir())) {
    try {
      fs.rmSync(authFile, { force: true });
    } catch {
      // best effort
    }
  }
  ctx.ui.notify(`계정 제거 완료: ${name} — 적용 중...`, "info");
  await ctx.reload();
}

function requirePool(deps: CommandDeps, ctx: ExtensionCommandContext): AccountPool | undefined {
  if (!deps.pool) {
    ctx.ui.notify(`설정 파일이 없습니다: ${deps.loaded.configPath}`, "warning");
    return undefined;
  }
  return deps.pool;
}

function pickTargets(
  pool: AccountPool,
  ctx: ExtensionCommandContext,
  name: string | undefined,
): AccountPool["runtimes"] | undefined {
  if (!name || name === "all") return pool.runtimes;
  const target = pool.byName(name);
  if (!target) {
    ctx.ui.notify(`계정을 찾을 수 없습니다: ${name}`, "warning");
    return undefined;
  }
  return [target];
}

async function testAccounts(deps: CommandDeps, ctx: ExtensionCommandContext, name?: string): Promise<void> {
  const pool = requirePool(deps, ctx);
  if (!pool) return;
  const targets = pickTargets(pool, ctx, name);
  if (!targets) return;

  ctx.ui.notify("계정 점검 중...", "info");
  const lines: string[] = [];
  for (const account of targets) {
    try {
      const auth = await account.resolveAuth();
      const base = (auth.baseUrl ?? (account.kind === "chatgpt" ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1")).replace(/\/+$/, "");
      const url = account.kind === "chatgpt" ? `${base}/codex/models?client_version=0.25.0` : `${base}/models`;
      const headers: Record<string, string> = { Authorization: `Bearer ${auth.apiKey}`, ...(auth.headers ?? {}) };
      if (account.kind === "chatgpt") {
        // Same headers pi-ai's Codex API sends (the backend rejects bare requests).
        const accountId = extractAccountId(auth.apiKey);
        if (accountId) headers["chatgpt-account-id"] = accountId;
        headers["originator"] = "pi";
      }
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        account.markOk();
        lines.push(`✓ ${account.name} — 정상 (${res.status})`);
      } else {
        const body = (await res.text().catch(() => "")).slice(0, 120);
        lines.push(`✗ ${account.name} — HTTP ${res.status} ${body}`);
      }
    } catch (e) {
      lines.push(`✗ ${account.name} — ${(e as Error).message.slice(0, 120)}`);
    }
  }
  void ctx.ui.select("openai-pool 계정 점검", lines);
}

async function resetAccounts(deps: CommandDeps, ctx: ExtensionCommandContext, name?: string): Promise<void> {
  const pool = requirePool(deps, ctx);
  if (!pool) return;
  const targets = pickTargets(pool, ctx, name);
  if (!targets) return;
  for (const account of targets) account.reset();
  deps.store.flush();
  pool.refreshStatus();
  ctx.ui.notify(`초기화 완료: ${targets.map((t) => t.name).join(", ")}`, "info");
}

async function toggleAccount(
  deps: CommandDeps,
  ctx: ExtensionCommandContext,
  sub: "enable" | "disable",
  name?: string,
): Promise<void> {
  const pool = requirePool(deps, ctx);
  if (!pool) return;
  if (!name) {
    ctx.ui.notify("사용법: /openai-pool enable|disable <계정이름>", "warning");
    return;
  }
  const account = pool.byName(name);
  if (!account) {
    ctx.ui.notify(`계정을 찾을 수 없습니다: ${name}`, "warning");
    return;
  }
  if (sub === "disable") account.manualDisable("수동 비활성");
  else account.reset();
  deps.store.flush();
  pool.refreshStatus();
  ctx.ui.notify(`${name}: ${sub === "disable" ? "비활성화" : "활성화"}`, "info");
}

async function pinAccount(deps: CommandDeps, ctx: ExtensionCommandContext, name?: string): Promise<void> {
  const pool = requirePool(deps, ctx);
  if (!pool) return;
  if (!name) {
    pool.state().pinned = undefined;
    deps.store.flush();
    ctx.ui.notify("계정 고정 해제 — 우선순위 순서대로 자동 선택", "info");
    return;
  }
  const account = pool.byName(name);
  if (!account) {
    ctx.ui.notify(`계정을 찾을 수 없습니다: ${name}`, "warning");
    return;
  }
  pool.state().pinned = name;
  deps.store.flush();
  pool.refreshStatus();
  ctx.ui.notify(`계정 고정: ${name}`, "info");
}
