/**
 * Provider registration: builds the model catalogs for the two pool providers
 * and registers them with failover-aware streams.
 *
 *   openai-pool  — serves OpenAI Responses/Completions models via `apiKey` accounts
 *   chatgpt-pool — serves Codex (ChatGPT backend) models via `chatgpt` accounts
 *
 * Model metadata (costs, context windows, compat flags) is copied from pi-ai's
 * built-in catalogs so usage accounting stays accurate.
 */

import {
  createProvider,
  type Api,
  getModels,
  type Model,
  openAICodexResponsesApi,
  openAICompletionsApi,
  openAIResponsesApi,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type CustomModelConfig,
  DEFAULT_BASE_URL,
  type Family,
  matchGlob,
  matchesPatterns,
  type PoolConfig,
} from "./config.ts";
import { makePoolStreams } from "./failover.ts";
import { type AccountPool, familyForApi } from "./pool.ts";

export const OPENAI_POOL = "openai-pool";
export const CHATGPT_POOL = "chatgpt-pool";
/** Built-in provider id taken over for chatgpt accounts (models stay untouched). */
export const OPENAI_CODEX = "openai-codex";

const POOL_NAME: Record<Family, string> = {
  apiKey: "OpenAI Pool",
  chatgpt: "ChatGPT Pool",
};

function customToModel(c: CustomModelConfig, family: Family): Model<Api> {
  const model: Model<Api> = {
    id: c.id,
    name: c.name || c.id,
    api: c.api as Api,
    provider: family === "chatgpt" ? CHATGPT_POOL : OPENAI_POOL,
    baseUrl: c.baseUrl ?? DEFAULT_BASE_URL[family],
    reasoning: c.reasoning ?? false,
    input: c.input ?? ["text"],
    cost: c.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: c.contextWindow ?? 128_000,
    maxTokens: c.maxTokens ?? 4_096,
  };
  if (c.thinkingLevelMap) model.thinkingLevelMap = c.thinkingLevelMap as Model<Api>["thinkingLevelMap"];
  if (c.headers) model.headers = c.headers;
  if (c.compat) model.compat = c.compat as Model<Api>["compat"];
  if (c.samplingParams) model.samplingParams = c.samplingParams;
  return model;
}

export interface BuiltModels {
  openai: Model<Api>[];
  chatgpt: Model<Api>[];
}

export function buildModels(config: PoolConfig): BuiltModels {
  const include = config.models.include?.length ? config.models.include : ["*"];
  const exclude = config.models.exclude ?? [];
  const keep = (id: string): boolean =>
    matchesPatterns(include, id) && !exclude.some((p) => matchGlob(p, id));

  const result: BuiltModels = { openai: [], chatgpt: [] };

  // Built-in OpenAI catalog (api.openai.com) -> apiKey accounts.
  for (const m of getModels("openai") as Model<Api>[]) {
    if (!keep(m.id)) continue;
    result.openai.push({ ...m, provider: OPENAI_POOL });
  }
  // Built-in Codex catalog (chatgpt.com backend) -> chatgpt accounts.
  for (const m of getModels("openai-codex") as Model<Api>[]) {
    if (!keep(m.id)) continue;
    result.chatgpt.push({ ...m, provider: CHATGPT_POOL });
  }
  // Config-defined models (e.g. proxies, fine-tunes) — same id replaces built-in.
  for (const c of config.models.custom ?? []) {
    if (!keep(c.id)) continue;
    const model = customToModel(c, familyForApi(c.api));
    const list = familyForApi(c.api) === "chatgpt" ? result.chatgpt : result.openai;
    const idx = list.findIndex((m) => m.id === c.id);
    if (idx >= 0) list.splice(idx, 1, model);
    else list.push(model);
  }
  return result;
}

export function registerProviders(pi: ExtensionAPI, config: PoolConfig, pool: AccountPool): string[] {
  const built = buildModels(config);
  const streams = makePoolStreams(
    {
      "openai-responses": openAIResponsesApi(),
      "openai-completions": openAICompletionsApi(),
      "openai-codex-responses": openAICodexResponsesApi(),
    },
    pool,
  );

  const registered: string[] = [];

  // ChatGPT accounts: transparently take over the built-in "openai-codex"
  // provider WITHOUT passing models, so pi keeps its full catalog (remote
  // catalog overlays like gpt-6-*, models.json additions) while every request
  // rotates across the pool. The legacy config form composes over the built-in:
  // our streamSimple handles model.api === "openai-codex-responses".
  if (pool.runtimes.some((r) => r.kind === "chatgpt")) {
    pi.registerProvider(OPENAI_CODEX, {
      name: "ChatGPT Pool",
      api: "openai-codex-responses",
      // Placeholder: the stream wrapper injects the real per-account tokens.
      apiKey: "openai-pool",
      // Replaces pi's stored single-account OAuth so a stale/refreshed token in
      // pi's credential store can never block requests. The pool manages the
      // real ChatGPT tokens itself (authFile / inline refresh tokens).
      oauth: {
        name: "ChatGPT Pool",
        isSubscription: true,
        login: async () => {
          throw new Error(
            "pi-openai-pool 이 계정을 관리합니다. 로그인은 codex login 또는 pi /login 후 ~/.pi/agent/openai-pool.json 에 authFile 등록 (/openai-pool status 참고)",
          );
        },
        refreshToken: async (credentials) => credentials,
        getApiKey: () => "openai-pool",
      },
      streamSimple: streams.streamSimple,
    });
    registered.push(OPENAI_CODEX);
  }

  // API-key accounts keep their own explicit namespace (openai-pool/*).
  const register = (id: string, family: Family, models: Model<Api>[]): void => {
    if (models.length === 0) return;
    const accounts = pool.runtimes.filter((r) => r.kind === family);
    if (accounts.length === 0) return;

    const provider: Provider = createProvider<Api>({
      id,
      name: POOL_NAME[family],
      baseUrl: DEFAULT_BASE_URL[family],
      auth: {
        apiKey: {
          name: `${POOL_NAME[family]} account`,
          async resolve() {
            const usable = accounts.filter((a) => a.entry.status !== "disabled");
            if (usable.length === 0) return undefined;
            // The pool injects the real per-attempt credentials in the stream
            // wrapper; this placeholder marks the provider as configured.
            return {
              auth: { apiKey: "openai-pool" },
              source: `${POOL_NAME[family]} (${usable.length}개 계정)`,
            };
          },
        },
      },
      models,
      api: {
        "openai-responses": streams,
        "openai-completions": streams,
        "openai-codex-responses": streams,
      },
    });
    pi.registerProvider(provider);
    registered.push(id);
  };

  register(OPENAI_POOL, "apiKey", built.openai);
  return registered;
}

export type { ProviderStreams };
