/**
 * pi-openai-pool — use multiple OpenAI accounts with priority-based failover.
 *
 * Accounts are tried in config order. When one hits its usage/rate limit it is
 * put on cooldown and the request transparently continues with the next
 * account; when that one runs out too, the next one takes over, and so on.
 * Recovered accounts return to the front of the line automatically.
 *
 * Providers registered (only when accounts of that kind are configured):
 *   openai-pool/gpt-5.4   — OpenAI API / compatible endpoints (`kind: "apiKey"`)
 *   chatgpt-pool/gpt-5.4  — ChatGPT plan accounts   (`kind: "chatgpt"`)
 *
 * Config: ~/.pi/agent/openai-pool.json   (see README.md, /openai-pool init)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./src/commands.ts";
import { loadConfig } from "./src/config.ts";
import { AccountPool } from "./src/pool.ts";
import { registerProviders } from "./src/providers.ts";
import { StateStore } from "./src/state.ts";

export default function (pi: ExtensionAPI) {
  const loaded = loadConfig();
  const store = new StateStore();

  if (!loaded.config) {
    registerCommands(pi, { store, loaded });
    pi.on("session_start", (_event, ctx) => {
      const msg = loaded.error
        ? `openai-pool 설정 오류: ${loaded.error}`
        : `openai-pool 설정 파일 없음: ${loaded.configPath} — /openai-pool init`;
      if (ctx.hasUI) ctx.ui.notify(msg, "warning");
    });
    return;
  }

  const pool = new AccountPool(loaded.config, store);
  registerProviders(pi, loaded.config, pool);
  registerCommands(pi, { pool, store, loaded });

  pi.on("session_start", (_event, ctx) => {
    pool.attachUI(ctx.hasUI ? ctx.ui : undefined);
    pool.refreshStatus();
  });

  pi.on("session_shutdown", () => {
    store.flush();
  });
}
