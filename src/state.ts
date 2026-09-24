/**
 * Persistent pool state: per-account status (cooldowns / exhaustion / usage
 * counters) stored in `~/.pi/agent/openai-pool.state.json`.
 *
 * The state file is the single source of truth shared by every pi process, so
 * an account that ran out of quota stays marked across restarts and sessions.
 */

import fs from "node:fs";
import path from "node:path";
import { getStatePath } from "./config.ts";

export type AccountStatus = "ok" | "cooldown" | "exhausted" | "disabled";

export interface AccountUsage {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
}

export interface ChatGPTTokens {
  access: string;
  refresh: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface AccountState {
  status: AccountStatus;
  /** Epoch ms until the account may recover (cooldown / exhausted). */
  until?: number;
  /** Human-readable reason for the current status. */
  reason?: string;
  usage: AccountUsage;
  lastUsedAt?: number;
  lastError?: string;
  /** Refreshed ChatGPT tokens (when not managed by an authFile). */
  tokens?: ChatGPTTokens;
}

export interface PoolState {
  accounts: Record<string, AccountState>;
  /** Last account that served a request (for rotate strategy + status display). */
  lastSelected?: string;
  /** Manually pinned account name ("use <name>"). */
  pinned?: string;
}

export function emptyAccountState(): AccountState {
  return { status: "ok", usage: { requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0 } };
}

export class StateStore {
  readonly path: string;
  state: PoolState;
  private saveTimer?: NodeJS.Timeout;

  constructor(statePath?: string) {
    this.path = statePath ?? getStatePath();
    this.state = this.read();
  }

  private read(): PoolState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, "utf8")) as PoolState;
      if (raw && typeof raw === "object" && raw.accounts && typeof raw.accounts === "object") {
        for (const entry of Object.values(raw.accounts)) {
          entry.usage ??= { requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
        }
        return raw;
      }
    } catch {
      // missing or corrupt state -> start fresh
    }
    return { accounts: {} };
  }

  account(name: string): AccountState {
    let entry = this.state.accounts[name];
    if (!entry) {
      entry = emptyAccountState();
      this.state.accounts[name] = entry;
    }
    entry.usage ??= { requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
    return entry;
  }

  /** Write through immediately (status changes must not be lost). */
  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n");
      fs.renameSync(tmp, this.path);
    } catch {
      // best effort: state persistence must never break requests
    }
  }

  /** Debounced save for high-frequency usage counter updates. */
  saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, 1_000);
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.save();
  }
}
