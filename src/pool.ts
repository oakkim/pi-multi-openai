/**
 * AccountPool: priority-ordered account selection plus failure bookkeeping.
 *
 * Selection semantics (strategy "priority"):
 *   1. Always try the highest-priority usable account first.
 *   2. When it fails with a quota/rate-limit style error it is put on cooldown
 *      (or marked exhausted) and the request fails over to the next account.
 *   3. When the cooldown expires the account becomes first in line again.
 *   4. If everything is cooling down, the soonest-recovering rate-limited
 *      account gets one best-effort attempt; if everything is exhausted or
 *      disabled the request fails with a summary.
 */

import type { AccountConfig, Family, PoolConfig } from "./config.ts";
import { matchesPatterns, resolveValue } from "./config.ts";
import { resolveChatGPTTokens } from "./chatgpt.ts";
import type { Failure } from "./errors.ts";
import type { AccountState, PoolState, StateStore } from "./state.ts";

export interface PoolUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}

export interface ResolvedAuth {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export interface PlanResult {
  accounts: AccountRuntime[];
  error?: string;
}

/** Which account kind serves a model, derived from the model API. */
export function familyForApi(api: string): Family {
  return api === "openai-codex-responses" ? "chatgpt" : "apiKey";
}

export class AccountRuntime {
  readonly config: AccountConfig;
  readonly entry: AccountState;
  private readonly store: StateStore;

  constructor(config: AccountConfig, entry: AccountState, store: StateStore) {
    this.config = config;
    this.entry = entry;
    this.store = store;
  }

  get name(): string {
    return this.config.name;
  }

  get kind(): Family {
    return this.config.kind === "chatgpt" ? "chatgpt" : "apiKey";
  }

  servesModel(modelId: string): boolean {
    return matchesPatterns(this.config.models, modelId);
  }

  isUsable(now = Date.now()): boolean {
    if (this.entry.status === "disabled") return false;
    if (this.entry.until !== undefined && this.entry.until > now) return false;
    return true;
  }

  isCoolingDown(now = Date.now()): boolean {
    return (
      (this.entry.status === "cooldown" || this.entry.status === "exhausted") &&
      this.entry.until !== undefined &&
      this.entry.until > now
    );
  }

  async resolveAuth(signal?: AbortSignal): Promise<ResolvedAuth> {
    const c = this.config;
    if (c.kind === "chatgpt") {
      const tokens = await resolveChatGPTTokens(c, this.entry, () => this.store.save(), signal);
      return { apiKey: tokens.access, baseUrl: c.baseUrl, headers: c.headers };
    }
    return {
      apiKey: resolveValue(c.apiKey ?? ""),
      baseUrl: c.baseUrl,
      headers: c.headers,
    };
  }

  markFailure(failure: Failure, message: string, policy: PoolConfig["policy"]): void {
    const now = Date.now();
    this.entry.lastError = message.slice(0, 500);
    switch (failure.cls) {
      case "usage":
        this.entry.status = "exhausted";
        this.entry.until = failure.until ?? now + policy.usageLimitCooldownMs;
        this.entry.reason = "사용량 소진";
        break;
      case "rate":
        this.entry.status = "cooldown";
        this.entry.until = failure.until ?? now + policy.rateLimitCooldownMs;
        this.entry.reason = "레이트 리밋";
        break;
      case "auth":
        this.entry.status = "disabled";
        this.entry.until = undefined;
        this.entry.reason = "인증 실패";
        break;
      case "transient":
        this.entry.status = "cooldown";
        this.entry.until = now + policy.transientCooldownMs;
        this.entry.reason = "일시적 오류";
        break;
      default:
        this.entry.reason = "오류";
        break;
    }
    this.store.save();
  }

  markOk(): void {
    if (this.entry.status !== "ok" || this.entry.reason) {
      this.entry.status = "ok";
      this.entry.reason = undefined;
      this.entry.until = undefined;
      this.entry.lastError = undefined;
    }
    this.store.save();
  }

  recordUsage(usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cost?: { total?: number };
  }): void {
    const u = this.entry.usage;
    u.requests += 1;
    u.input += usage.input ?? 0;
    u.output += usage.output ?? 0;
    u.cacheRead += usage.cacheRead ?? 0;
    u.cost += usage.cost?.total ?? 0;
    this.entry.lastUsedAt = Date.now();
    this.store.saveSoon();
  }

  manualDisable(reason: string): void {
    this.entry.status = "disabled";
    this.entry.until = undefined;
    this.entry.reason = reason;
    this.store.save();
  }

  reset(): void {
    this.entry.status = "ok";
    this.entry.until = undefined;
    this.entry.reason = undefined;
    this.entry.lastError = undefined;
    this.store.save();
  }
}

export class AccountPool {
  readonly runtimes: AccountRuntime[];
  readonly config: PoolConfig;
  readonly store: StateStore;
  private ui?: PoolUI;

  constructor(config: PoolConfig, store: StateStore) {
    this.config = config;
    this.store = store;
    this.runtimes = config.accounts.map((a) => new AccountRuntime(a, store.account(a.name), store));
    // Drop state entries for accounts that no longer exist in the config.
    const known = new Set(config.accounts.map((a) => a.name));
    for (const key of Object.keys(store.state.accounts)) {
      if (!known.has(key)) delete store.state.accounts[key];
    }
  }

  attachUI(ui: PoolUI | undefined): void {
    this.ui = ui;
  }

  state(): PoolState {
    return this.store.state;
  }

  byName(name: string): AccountRuntime | undefined {
    return this.runtimes.find((r) => r.name === name);
  }

  /** Accounts of a family that can serve the model, in config (priority) order. */
  matching(family: Family, modelId: string): AccountRuntime[] {
    return this.runtimes.filter((r) => r.kind === family && r.servesModel(modelId));
  }

  /**
   * Build the ordered attempt plan for one request.
   * Available accounts first (priority/rotate/pin aware); if none are available
   * a single soonest-recovering cooldown account is offered as a last resort.
   */
  plan(family: Family, modelId: string): PlanResult {
    const now = Date.now();
    const matching = this.matching(family, modelId);
    if (matching.length === 0) {
      return {
        accounts: [],
        error: `openai-pool: 이 모델(${modelId})을 처리할 계정이 없습니다. /openai-pool status 로 설정을 확인하세요`,
      };
    }

    let available = matching.filter((r) => r.isUsable(now));
    if (this.config.strategy === "rotate" && available.length > 1) {
      const last = this.store.state.lastSelected;
      const idx = available.findIndex((r) => r.name === last);
      if (idx >= 0) available = [...available.slice(idx + 1), ...available.slice(0, idx + 1)];
    }
    const pinned = this.store.state.pinned;
    if (pinned) {
      const p = available.findIndex((r) => r.name === pinned);
      if (p > 0) available = [available[p], ...available.slice(0, p), ...available.slice(p + 1)];
    }
    if (available.length > 0) return { accounts: available };

    // Best-effort fallback: the cooling-down account closest to recovery.
    const cooling = matching
      .filter((r) => r.entry.status === "cooldown" && r.isCoolingDown(now))
      .sort((a, b) => (a.entry.until ?? 0) - (b.entry.until ?? 0));
    if (cooling.length > 0) return { accounts: [cooling[0]] };

    const details = matching
      .map((r) => `${r.name}(${statusText(r, now)})`)
      .join(", ");
    return {
      accounts: [],
      error: `openai-pool: 사용 가능한 계정이 없습니다 — 모든 계정이 소진/비활성 상태입니다 [${details}]. /openai-pool reset 으로 초기화하세요`,
    };
  }

  notifyFailover(from: AccountRuntime, failure: Failure, next: AccountRuntime | undefined): void {
    const reason =
      failure.cls === "usage"
        ? "사용량 소진"
        : failure.cls === "rate"
          ? "레이트 리밋"
          : failure.cls === "auth"
            ? "인증 실패"
            : "일시적 오류";
    const dest = next ? `${next.name}(으)로 전환` : "다음 계정 없음";
    this.ui?.notify(`openai-pool: ${from.name} ${reason} → ${dest}`, "warning");
    if (next) this.ui?.setStatus("openai-pool", `⇄ ${next.name}`);
  }

  notifySelected(account: AccountRuntime): void {
    this.store.state.lastSelected = account.name;
    this.store.saveSoon();
    this.ui?.setStatus("openai-pool", `⇄ ${account.name}`);
  }

  refreshStatus(): void {
    const now = Date.now();
    const active = this.store.state.lastSelected
      ? this.byName(this.store.state.lastSelected)
      : this.runtimes.find((r) => r.isUsable(now));
    this.ui?.setStatus("openai-pool", active ? `⇄ ${active.name}` : "⇄ 없음");
  }
}

export function statusText(runtime: AccountRuntime, now = Date.now()): string {
  const e = runtime.entry;
  switch (e.status) {
    case "disabled":
      return e.reason ? `비활성(${e.reason})` : "비활성";
    case "exhausted": {
      const left = e.until && e.until > now ? ` ${formatDuration(e.until - now)} 후 복구 예정` : "";
      return `사용량 소진${left}`;
    }
    case "cooldown": {
      const left = e.until && e.until > now ? ` ${formatDuration(e.until - now)} 후 복구 예정` : "";
      return `${e.reason ?? "쿨다운"}${left}`;
    }
    default:
      return "사용 가능";
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${s % 60}초`;
  return `${s}초`;
}
