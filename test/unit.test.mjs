import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyFailure, parseRetryAfter, parseResetTime } from "../src/errors.ts";
import { matchGlob, parseConfig, resolveValue, matchesPatterns } from "../src/config.ts";
import { AccountPool, formatDuration } from "../src/pool.ts";
import { StateStore } from "../src/state.ts";

// ---------------------------------------------------------------------------
// errors.ts
// ---------------------------------------------------------------------------

test("usage-limit errors classify as usage with optional reset time", () => {
  const f = classifyFailure("You exceeded your current quota, insufficient_quota.");
  assert.equal(f.cls, "usage");

  const future = new Date(Date.now() + 3600_000).toISOString();
  const withReset = classifyFailure(`usage limit reached, try again at ${future}`);
  assert.equal(withReset.cls, "usage");
  assert.ok(parseResetTime(`resets at ${future}`) > Date.now());
});

test("rate-limit errors classify as rate and honor retry-after", () => {
  const f = classifyFailure("Rate limit reached for requests", 429, { "Retry-After": "120" });
  assert.equal(f.cls, "rate");
  assert.ok(f.until && f.until - Date.now() > 100_000);

  assert.equal(parseRetryAfter("not-a-number"), undefined);
  assert.ok(parseRetryAfter("5") > Date.now());
});

test("auth / transient / other classification", () => {
  assert.equal(classifyFailure("Incorrect API key provided", 401).cls, "auth");
  assert.equal(classifyFailure("fetch failed: ECONNRESET", undefined).cls, "transient");
  assert.equal(classifyFailure("tools[0].parameters is invalid", 400).cls, "other");
  assert.equal(classifyFailure("stop", undefined, undefined, true).cls, "aborted");
});

test("parseResetTime ignores past timestamps", () => {
  const past = new Date(Date.now() - 3600_000).toISOString();
  assert.equal(parseResetTime(`resets at ${past}`), undefined);
});

// ---------------------------------------------------------------------------
// config.ts
// ---------------------------------------------------------------------------

test("parseConfig validates accounts and applies defaults", () => {
  const cfg = parseConfig(
    JSON.stringify({
      accounts: [
        { name: "a", kind: "chatgpt", refreshToken: "r1" },
        { name: "b", kind: "apiKey", apiKey: "$KEY" },
      ],
    }),
  );
  assert.equal(cfg.accounts.length, 2);
  assert.equal(cfg.strategy, "priority");
  assert.ok(cfg.policy.usageLimitCooldownMs > 0);
  assert.throws(() => parseConfig(JSON.stringify({ accounts: [{ name: "x", kind: "nope" }] })));
  assert.throws(() =>
    parseConfig(JSON.stringify({ accounts: [{ name: "a", kind: "apiKey" }, { name: "a", kind: "apiKey", apiKey: "k" }] })),
  );
});

test("resolveValue interpolates env vars and commands", () => {
  process.env.POOL_TEST_VAR = "hello";
  assert.equal(resolveValue("pre-$POOL_TEST_VAR-post"), "pre-hello-post");
  assert.equal(resolveValue("${POOL_TEST_VAR}"), "hello");
  assert.equal(resolveValue("!echo cmd-out"), "cmd-out");
  delete process.env.POOL_TEST_VAR;
});

test("glob matching for model filters", () => {
  assert.ok(matchGlob("gpt-5*", "gpt-5.4"));
  assert.ok(!matchGlob("gpt-5*", "o3"));
  assert.ok(matchGlob("*", "anything"));
  assert.ok(matchesPatterns(undefined, "x"));
  assert.ok(!matchesPatterns(["gpt-5*"], "o3"));
});

// ---------------------------------------------------------------------------
// pool.ts
// ---------------------------------------------------------------------------

function makePool(accounts, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-test-"));
  const store = new StateStore(path.join(dir, "state.json"));
  const config = parseConfig(
    JSON.stringify({
      accounts,
      ...extra,
      policy: {
        rateLimitCooldownMs: 60_000,
        usageLimitCooldownMs: 5 * 3600_000,
        transientCooldownMs: 30_000,
        attemptRetries: 0,
        ...(extra.policy ?? {}),
      },
    }),
  );
  return { pool: new AccountPool(config, store), store };
}

const POLICY = {
  rateLimitCooldownMs: 60_000,
  usageLimitCooldownMs: 5 * 3600_000,
  transientCooldownMs: 30_000,
  attemptRetries: 0,
};

test("plan follows config priority order", () => {
  const { pool } = makePool([
    { name: "first", kind: "apiKey", apiKey: "k1" },
    { name: "second", kind: "apiKey", apiKey: "k2" },
    { name: "other-kind", kind: "chatgpt", refreshToken: "r" },
  ]);
  const plan = pool.plan("apiKey", "gpt-5.4");
  assert.deepEqual(
    plan.accounts.map((a) => a.name),
    ["first", "second"],
  );
});

test("exhausted accounts are skipped and recovered accounts return to the front", () => {
  const { pool } = makePool([
    { name: "first", kind: "apiKey", apiKey: "k1" },
    { name: "second", kind: "apiKey", apiKey: "k2" },
  ]);
  const first = pool.byName("first");
  first.markFailure({ cls: "usage" }, "quota exceeded", POLICY);
  assert.equal(first.entry.status, "exhausted");
  let plan = pool.plan("apiKey", "gpt-5.4");
  assert.deepEqual(plan.accounts.map((a) => a.name), ["second"]);

  // simulate recovery
  first.entry.until = Date.now() - 1;
  plan = pool.plan("apiKey", "gpt-5.4");
  assert.deepEqual(plan.accounts.map((a) => a.name), ["first", "second"]);
});

test("auth failure disables the account permanently until reset", () => {
  const { pool } = makePool([
    { name: "first", kind: "apiKey", apiKey: "k1" },
    { name: "second", kind: "apiKey", apiKey: "k2" },
  ]);
  const first = pool.byName("first");
  first.markFailure({ cls: "auth" }, "Incorrect API key", POLICY);
  assert.equal(first.entry.status, "disabled");
  first.entry.until = Date.now() - 1;
  assert.equal(pool.plan("apiKey", "gpt-5.4").accounts.map((a) => a.name).join(), "second");
  first.reset();
  assert.equal(pool.plan("apiKey", "gpt-5.4").accounts.map((a) => a.name).join(), "first,second");
});

test("when everything is cooling down the soonest-recovering account is the fallback", () => {
  const { pool } = makePool([
    { name: "slow", kind: "apiKey", apiKey: "k1" },
    { name: "fast", kind: "apiKey", apiKey: "k2" },
  ]);
  pool.byName("slow").markFailure({ cls: "rate" }, "429", POLICY);
  pool.byName("fast").markFailure({ cls: "rate" }, "429", POLICY);
  pool.byName("slow").entry.until = Date.now() + 500_000;
  pool.byName("fast").entry.until = Date.now() + 10_000;
  const plan = pool.plan("apiKey", "gpt-5.4");
  assert.equal(plan.accounts.map((a) => a.name).join(), "fast");
});

test("all-exhausted produces a descriptive error", () => {
  const { pool } = makePool([{ name: "only", kind: "apiKey", apiKey: "k1" }]);
  pool.byName("only").markFailure({ cls: "usage" }, "quota", POLICY);
  const plan = pool.plan("apiKey", "gpt-5.4");
  assert.equal(plan.accounts.length, 0);
  assert.match(plan.error, /openai-pool/);
});

test("rotate strategy spreads selection across accounts", () => {
  const { pool, store } = makePool(
    [
      { name: "a", kind: "apiKey", apiKey: "k1" },
      { name: "b", kind: "apiKey", apiKey: "k2" },
    ],
    { strategy: "rotate" },
  );
  assert.equal(pool.plan("apiKey", "m").accounts[0].name, "a");
  store.state.lastSelected = "a";
  assert.equal(pool.plan("apiKey", "m").accounts[0].name, "b");
});

test("pinned account wins over priority", () => {
  const { pool, store } = makePool([
    { name: "a", kind: "apiKey", apiKey: "k1" },
    { name: "b", kind: "apiKey", apiKey: "k2" },
  ]);
  store.state.pinned = "b";
  assert.equal(pool.plan("apiKey", "m").accounts[0].name, "b");
});

test("per-account model filters restrict candidates", () => {
  const { pool } = makePool([
    { name: "mini-only", kind: "apiKey", apiKey: "k1", models: ["*-mini"] },
    { name: "any", kind: "apiKey", apiKey: "k2" },
  ]);
  assert.equal(pool.plan("apiKey", "gpt-5.4").accounts.map((a) => a.name).join(), "any");
  assert.equal(pool.plan("apiKey", "gpt-5.4-mini").accounts.map((a) => a.name).join(), "mini-only,any");
});

test("usage counters accumulate", () => {
  const { pool } = makePool([{ name: "a", kind: "apiKey", apiKey: "k1" }]);
  const a = pool.byName("a");
  a.recordUsage({ input: 10, output: 5, cacheRead: 2, cost: { total: 0.25 } });
  a.recordUsage({ input: 1, output: 1, cacheRead: 0, cost: { total: 0.05 } });
  assert.equal(a.entry.usage.requests, 2);
  assert.equal(a.entry.usage.input, 11);
  assert.equal(a.entry.usage.cost, 0.3);
});

test("formatDuration renders human-friendly units", () => {
  assert.equal(formatDuration(5_000), "5초");
  assert.equal(formatDuration(65_000), "1분 5초");
  assert.equal(formatDuration(3_930_000), "1시간 5분");
});

// ---------------------------------------------------------------------------
// chatgpt.ts auth file shapes
// ---------------------------------------------------------------------------

test("auth file parsing supports Codex CLI and pi credential stores", async () => {
  const { readTokensFromAuthFile, writeTokensToAuthFile } = await import("../src/chatgpt.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));

  // Codex CLI shape
  const codex = path.join(dir, "codex.json");
  fs.writeFileSync(
    codex,
    JSON.stringify({ tokens: { access_token: "a1", refresh_token: "r1", expires_at: 1791026278 } }),
  );
  let t = readTokensFromAuthFile(codex);
  assert.equal(t.access, "a1");
  assert.ok(t.expiresAt > 1e12, "seconds normalized to ms");
  writeTokensToAuthFile(codex, { access: "a2", refresh: "r2", expiresAt: 1791026278000 });
  t = readTokensFromAuthFile(codex);
  assert.equal(t.access, "a2");
  assert.ok(fs.readFileSync(codex, "utf8").includes('"expires_at": 1791026278'), "seconds preserved");

  // pi auth.json shape
  const pi = path.join(dir, "pi.json");
  fs.writeFileSync(
    pi,
    JSON.stringify({ "openai-codex": { type: "oauth", access: "pa", refresh: "pr", expires: 1791026278854 } }),
  );
  t = readTokensFromAuthFile(pi);
  assert.equal(t.access, "pa");
  assert.equal(t.refresh, "pr");
  assert.equal(t.expiresAt, 1791026278854);
  writeTokensToAuthFile(pi, { access: "pa2", refresh: "pr2", expiresAt: 1891026278854 });
  t = readTokensFromAuthFile(pi);
  assert.equal(t.access, "pa2");
  assert.equal(t.refresh, "pr2");
});

// ---------------------------------------------------------------------------
// config mutation + managed token store (account onboarding)
// ---------------------------------------------------------------------------

test("updateConfigFile creates and merges accounts preserving other fields", async () => {
  process.env.OPENAI_POOL_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cfg-test-")), "config.json");
  const { updateConfigFile, tokenStorePathFor, getTokenStoreDir, writeTokenStoreFile, readTokensFromAuthFile } =
    await import("../src/config.ts").then(async (c) => ({ ...c, ...(await import("../src/chatgpt.ts")) }));

  // create from nothing
  updateConfigFile((r) => r.accounts.push({ name: "a", kind: "chatgpt", refreshToken: "r1" }));
  // merge, preserving sibling fields
  updateConfigFile((r) => {
    r.strategy = "rotate";
    r.accounts.push({ name: "b", kind: "apiKey", apiKey: "sk-x" });
  });
  const raw = JSON.parse(fs.readFileSync(process.env.OPENAI_POOL_CONFIG, "utf8"));
  assert.equal(raw.accounts.length, 2);
  assert.equal(raw.strategy, "rotate");
  assert.equal(raw.accounts[0].refreshToken, "r1");

  // managed token store round-trip (Codex auth.json shape)
  const file = tokenStorePathFor("my acct/1");
  assert.ok(file.startsWith(getTokenStoreDir()));
  assert.ok(!file.includes(" "), "name sanitized for filename");
  writeTokenStoreFile(file, { access: "aa", refresh: "rr", expiresAt: 1791026278000 });
  const t = readTokensFromAuthFile(file);
  assert.equal(t.access, "aa");
  assert.equal(t.refresh, "rr");
  assert.equal(t.expiresAt, 1791026278000);

  delete process.env.OPENAI_POOL_CONFIG;
});
