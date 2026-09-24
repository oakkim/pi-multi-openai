# pi-openai-pool

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that lets you
**use multiple OpenAI accounts with priority-based failover**. When the
higher-priority account runs out of usage or hits a rate limit, requests
automatically fall over to the next account — and to the next one after that.
When an account recovers, it goes back to the front of the line.

```
 request ──► account #1 (usage exhausted) ──► account #2 (usage exhausted) ──► account #3 ✓
                  │ cooldown recorded             │ cooldown recorded
                  └─ back to #1 automatically once it recovers
```

## Supported account kinds

| kind | Account | Models used | Credentials |
|---|---|---|---|
| `chatgpt` | ChatGPT plans (Plus/Pro, …) | existing `openai-codex/*` models (Codex) | Codex `auth.json` or refresh token |
| `apiKey` | OpenAI API keys (or OpenAI-compatible endpoints) | `openai-pool/*` models | API key |

Both kinds can be mixed in one config. Failover for a request happens across
the accounts of the matching kind, in priority order.

**ChatGPT accounts are transparent**: the extension takes over the built-in
`openai-codex` provider (models, remote catalog, `models.json` entries all stay
exactly as they are) and only swaps the request pipeline for pool rotation —
so `openai-codex/gpt-6-*` etc. keep working with zero changes to your workflow.

## Install

```bash
# option 1: install as a pi package (registered in settings.json automatically)
pi install git:github.com/oakkim/pi-multi-openai

# option 2: link it manually
ln -s ~/Projects/pi-multi-openai ~/.pi/agent/extensions/openai-pool
```

Then set up your accounts interactively:

```
inside pi:  /openai-pool add      (browser login / paste token / API key)
```

or write `~/.pi/agent/openai-pool.json` by hand (see below).

For per-project usage, link it into `.pi/extensions/` or add the path to the
`extensions` array in `settings.json`.

## Adding accounts

`/openai-pool add` walks you through everything:

1. **ChatGPT — browser login (recommended)** — opens the ChatGPT device-login
   page, shows a one-time code in a widget, and stores the tokens for you
   (`~/.pi/agent/openai-pool-tokens/<name>.json`). Nothing to copy around.
2. **ChatGPT — paste refresh token** — for tokens you already have
   (e.g. from `~/.codex/auth.json`).
3. **OpenAI API key** — literal / `$ENV` / `!command`, with optional custom
   endpoint (OpenAI-compatible proxies work too).

Then pick the priority position (front or back of the queue) and you're done.
Token refresh is automatic afterwards (rotated tokens are written back).

- `/openai-pool login <name>` — re-login a ChatGPT account (after auth failure)
- `/openai-pool remove <name>` — remove an account (and its stored tokens)

## Configuration

`~/.pi/agent/openai-pool.json` (override the location with `OPENAI_POOL_CONFIG`)

```json
{
  "accounts": [
    { "name": "main",    "kind": "chatgpt", "authFile": "~/.codex/auth.json" },
    { "name": "sub-1",   "kind": "chatgpt", "refreshToken": "..." },
    { "name": "sub-2",   "kind": "chatgpt", "refreshToken": "...", "models": ["gpt-6*"] },
    { "name": "api-key", "kind": "apiKey",  "apiKey": "$OPENAI_API_KEY" }
  ],
  "strategy": "priority",
  "models": {
    "include": ["*"],
    "exclude": [],
    "custom": [
      { "id": "my-proxy-model", "name": "Proxy Model", "api": "openai-completions",
        "baseUrl": "https://proxy.example.com/v1", "contextWindow": 128000, "maxTokens": 8192 }
    ]
  },
  "policy": {
    "rateLimitCooldownMs": 60000,
    "usageLimitCooldownMs": 18000000,
    "transientCooldownMs": 30000,
    "attemptRetries": 0
  }
}
```

- **The `accounts` array order IS the priority order.** Account #1 always
  serves first; when it gets blocked, requests fall over to #2, #3, …
- `apiKey`: accepts a literal, `$ENV` / `${ENV}` interpolation, or `!command`
  (command output).
- `chatgpt` credentials: with `authFile` (e.g. Codex CLI's `~/.codex/auth.json`
  or pi's `~/.pi/agent/auth.json`) the extension reads and refreshes the tokens
  and writes rotated tokens back in the same format. Accounts added via
  `/openai-pool add` store tokens in `~/.pi/agent/openai-pool-tokens/`.
  With inline `refreshToken`/`accessToken`, refreshed tokens are stored in the
  state file.
- `models`: per-account model filter (`*` globs). E.g. `["gpt-6*"]` makes the
  account only serve `gpt-6*` requests.
- `models.custom`: models missing from the catalog (proxies, fine-tunes) —
  same-id entries replace built-ins. API-key accounts only; for `openai-codex`
  models use `~/.pi/agent/models.json` as usual (pi composes it natively).
- `strategy`: `priority` (default: always the highest-priority usable account)
  or `rotate` (spread load round-robin; failover on exhaustion behaves the same).

### Exhaustion detection & cooldowns

| Failure | Examples | Handling |
|---|---|---|
| Usage / quota | `insufficient_quota`, `usage limit`, billing | marked exhausted for `usageLimitCooldownMs` (default 5 h), or until the reset time when the error states one |
| Rate limit | 429, `rate limit`, `Retry-After` | `Retry-After` header, else `rateLimitCooldownMs` (default 60 s) |
| Auth | 401, `invalid api key`, `invalid_grant` | account disabled (excluded until `/openai-pool enable`) |
| Transient | 5xx, network | `transientCooldownMs` (default 30 s) |

State (cooldowns / exhaustion / usage) is persisted to
`~/.pi/agent/openai-pool.state.json`, so it survives pi restarts.

## Usage

For ChatGPT accounts, nothing to select — keep using `openai-codex/*` models as
always. For API-key accounts pick a pool model:

```
/model openai-pool/gpt-5.4
```

Then just work. When an account runs out, the request transparently continues
with the next one and you get a notification
(`openai-pool: main usage exhausted → switching to sub-1`) plus an updated
status-bar entry (`⇄ sub-1`).

### `/openai-pool` commands

| Command | Description |
|---|---|
| `/openai-pool` | per-account status, usage, and recent errors |
| `/openai-pool add` | add an account interactively (browser login / token / API key) |
| `/openai-pool login <name>` | re-login a ChatGPT account |
| `/openai-pool remove <name>` | remove an account |
| `/openai-pool init` | create a sample config if none exists |
| `/openai-pool test [name]` | live-check account credentials/availability |
| `/openai-pool reset [name\|all]` | clear cooldown / exhausted / disabled state |
| `/openai-pool enable\|disable <name>` | manually enable / disable an account |
| `/openai-pool use [name]` | pin an account (no arg = unpin) |
| `/openai-pool reload` | re-read the config |

## Design notes

- **When every account is exhausted** the request fails with
  `openai-pool: all accounts failed (...)`. If pi's automatic retry later picks
  the request up and an account has recovered, it is used automatically.
- **Failures after output has already streamed** are surfaced as-is (no
  duplicate output). Usage-limit errors almost always happen at request start,
  so failover is transparent in practice.
- For the `openai-codex` takeover the extension neutralizes pi's stored
  single-account OAuth credential, so a stale token in pi's credential store
  can never block requests; the pool manages all ChatGPT tokens itself.
- Model metadata (costs, context windows, compat flags) comes from pi-ai's
  built-in catalogs, so token/cost accounting stays accurate.

## Tests

```bash
node --test test/unit.test.mjs   # classification / selection / cooldown logic
./test/e2e.sh                    # mock server + real pi failover verification
```
