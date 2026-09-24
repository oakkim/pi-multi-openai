/**
 * Failover stream wrapper.
 *
 * Wraps a pi-ai stream implementation (openai-responses / openai-completions /
 * openai-codex-responses) and rotates through the account pool: each attempt
 * uses one account; quota / rate-limit / auth failures before any content has
 * been streamed mark that account and transparently retry with the next one.
 */

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type ProviderResponse,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { classifyFailure, type Failure } from "./errors.ts";
import { familyForApi, type AccountPool, type AccountRuntime } from "./pool.ts";

export function makePoolStreams(apis: Record<string, ProviderStreams>, pool: AccountPool): ProviderStreams {
  return {
    stream: (model, context, options) => runAttempt(apis, pool, model, context, options, false),
    streamSimple: (model, context, options) => runAttempt(apis, pool, model, context, options, true),
  };
}

function runAttempt(
  apis: Record<string, ProviderStreams>,
  pool: AccountPool,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | StreamOptions | undefined,
  simple: boolean,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void failoverLoop(apis, pool, model, context, options, simple, out);
  return out;
}

async function failoverLoop(
  apis: Record<string, ProviderStreams>,
  pool: AccountPool,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | StreamOptions | undefined,
  simple: boolean,
  out: AssistantMessageEventStream,
): Promise<void> {
  const family = familyForApi(model.api);
  const plan = pool.plan(family, model.id);
  if (plan.accounts.length === 0) {
    pushError(out, model, plan.error ?? "openai-pool: 사용 가능한 계정이 없습니다");
    out.end();
    return;
  }

  const attempts: string[] = [];
  let nextIndex = 0;

  for (const account of plan.accounts) {
    if (options?.signal?.aborted) {
      pushError(out, model, "Request aborted", "aborted");
      out.end();
      return;
    }
    const next = plan.accounts[nextIndex + 1];
    nextIndex += 1;

    let auth;
    try {
      auth = await account.resolveAuth(options?.signal);
    } catch (e) {
      account.markFailure({ cls: "auth" }, (e as Error).message, pool.config.policy);
      attempts.push(`${account.name}: 인증 실패`);
      pool.notifyFailover(account, { cls: "auth" }, next);
      continue;
    }

    const impl = apis[model.api] ?? apis[family === "chatgpt" ? "openai-codex-responses" : "openai-responses"];
    if (!impl) {
      pushError(out, model, `openai-pool: 지원하지 않는 API입니다 (${model.api})`);
      out.end();
      return;
    }

    const attemptModel: Model<Api> = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
    let lastResponse: ProviderResponse | undefined;
    const baseOptions = (options ?? {}) as StreamOptions & SimpleStreamOptions;
    const attemptOptions = {
      ...baseOptions,
      apiKey: auth.apiKey,
      headers: { ...(baseOptions.headers ?? {}), ...(auth.headers ?? {}) },
      maxRetries: baseOptions.maxRetries ?? pool.config.policy.attemptRetries,
      onResponse: (response: ProviderResponse, m: Model<Api>) => {
        lastResponse = response;
        baseOptions.onResponse?.(response, m);
      },
    };

    const inner = simple
      ? impl.streamSimple(attemptModel, context, attemptOptions)
      : impl.stream(attemptModel, context, attemptOptions);

    let startEvent: AssistantMessageEvent | undefined;
    let startForwarded = false;
    let contentEmitted = false;
    let terminal: AssistantMessageEvent | undefined;

    const flushStart = (partial: AssistantMessage | undefined) => {
      if (startForwarded) return;
      startForwarded = true;
      out.push((startEvent as AssistantMessageEvent) ?? { type: "start", partial: partial! });
    };

    try {
      for await (const ev of inner) {
        if (ev.type === "start") {
          startEvent = ev;
          continue;
        }
        if (ev.type === "done" || ev.type === "error") {
          terminal = ev;
          break;
        }
        contentEmitted = true;
        flushStart(ev.partial);
        out.push(ev);
      }
    } catch (e) {
      terminal = undefined;
      pushError(out, model, (e as Error).message, "error", flushStart);
      out.end();
      return;
    }

    if (!terminal) {
      pushError(out, model, "openai-pool: 스트림이 예고 없이 종료되었습니다", "error", flushStart);
      out.end();
      return;
    }

    if (terminal.type === "done") {
      account.recordUsage(terminal.message.usage ?? {});
      account.markOk();
      pool.notifySelected(account);
      flushStart(terminal.message);
      out.push(terminal);
      out.end();
      return;
    }

    // error path
    const errorMessage = terminal.error.errorMessage ?? "Unknown error";
    const failure: Failure = classifyFailure(
      errorMessage,
      lastResponse?.status,
      lastResponse?.headers,
      options?.signal?.aborted ?? false,
    );

    // Safe failover only when nothing was streamed yet and the failure is account-related.
    if (!contentEmitted && failure.cls !== "other" && failure.cls !== "aborted") {
      account.markFailure(failure, errorMessage, pool.config.policy);
      attempts.push(`${account.name}: ${failure.cls === "usage" ? "사용량 소진" : failure.cls === "rate" ? "레이트 리밋" : failure.cls === "auth" ? "인증 실패" : "일시적 오류"}`);
      pool.notifyFailover(account, failure, next);
      continue;
    }

    flushStart(terminal.error);
    out.push(terminal);
    out.end();
    return;
  }

  const summary =
    attempts.length > 0
      ? `openai-pool: 모든 계정 시도 실패 (${attempts.join(" / ")}) — /openai-pool status 로 확인하세요`
      : `openai-pool: 모든 계정이 소진/비활성 상태입니다 — /openai-pool status 로 확인하세요`;
  pushError(out, model, summary);
  out.end();
}

function pushError(
  out: AssistantMessageEventStream,
  model: Model<Api>,
  message: string,
  reason: "error" | "aborted" = "error",
  flushStart?: (partial: AssistantMessage | undefined) => void,
): void {
  const error: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: reason,
    errorMessage: message,
    timestamp: Date.now(),
  };
  flushStart?.(error);
  out.push({ type: "error", reason, error });
}
